import { docKey, type DocumentRef } from "../mapping";
import { placeQuote, looseText, plainQuote } from "../shared/anchoring/anchor";
import {
  COMMENT_SAVE_WAIT,
  COMMENT_WORDS,
  countOccurrences,
  createLocalIntents,
  extractSuggestionFromComments,
  failureWords,
  findConversation,
  concernsDocument,
  createPollGateFor,
  isSuggestionStillApplied,
  type LiveEvent,
  normalizeLineEndings,
  openThreadCount,
  type PollSignals,
  type PrInfo,
  ReviewOpener,
  type SuggestionSnapshot,
  type ThreadAnchorLines,
  ThreadsStore,
  type ThreadsStoreDeps,
} from "../shared/review-flow";
import { type CommentsPort, isReviewNotOpen } from "./api";
import type { ApplyStatus, CommentMarks, MarkThread } from "./marks";
import { PLUGIN_COMMENT_WORDS } from "./words";

export interface Draft {
  quote: string;
  from: number;
  to: number;
  lineStart: number;
  lineEnd: number;
}

export interface NoteUi {
  selectedId: string | null;
  draft: Draft | null;
  draftBody: string;
  posting: boolean;
  focusRequests: number;
  waiting: boolean;
  applyingId: string | null;
}

export interface CommentsHost {
  marks: CommentMarks;
  api: CommentsPort;
  documentFor(path: string): DocumentRef | null;
  signedIn(): boolean;
  me: ThreadsStoreDeps["me"];
  isLive(path: string): boolean;
  saveNote(path: string): Promise<void>;
  discardUnsent(quote: string): Promise<boolean>;
  error(title: string, description: string): void;
  stay(title: string, description: string): void;
  alert(title: string, description: string): Promise<void>;
  showPanel(): void | Promise<void>;
  afterJump(): void;
  signals: PollSignals;
  every(run: () => void, ms: number): () => void;
  wait(ms: number): Promise<void>;
  later(run: () => void, ms: number): void;
  now?(): number;
}

interface AppliedSuggestion {
  snapshot: SuggestionSnapshot;
  saved: boolean;
  savedText: string | null;
}

function isAppliedPresent(entry: AppliedSuggestion, text: string | null): boolean {
  if (text === null) return false;
  return isSuggestionStillApplied(entry.snapshot, {
    replaceCount: (needle) => countOccurrences(text, needle),
    findCount: (needle) => countOccurrences(text, needle),
    sourceCount: (needle) => countOccurrences(text, needle),
  });
}

export class NoteComments {
  readonly store: ThreadsStore;
  private ui: NoteUi = { selectedId: null, draft: null, draftBody: "", posting: false, focusRequests: 0, waiting: false, applyingId: null };
  private readonly listeners = new Set<() => void>();
  private readonly applied = new Map<string, AppliedSuggestion>();
  private sending = false;
  private applying = false;
  private seq = 0;

  constructor(
    readonly path: string,
    readonly doc: DocumentRef,
    private readonly host: CommentsHost,
    store: ThreadsStore,
  ) {
    this.store = store;
    store.subscribe(() => {
      if (!this.applying) {
        const threads = this.store.getState().threads;
        for (const id of [...this.applied.keys()]) {
          if (findConversation(threads, id)?.resolved) this.applied.delete(id);
        }
      }
      this.show();
    });
  }

  getUi = (): NoteUi => this.ui;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(change: Partial<NoteUi>): void {
    const selection = this.ui.selectedId;
    this.ui = { ...this.ui, ...change };
    if (this.ui.selectedId !== selection) this.host.marks.setActive(this.path, this.ui.selectedId);
    this.listeners.forEach((listener) => listener());
  }

  show(): void {
    const threads: MarkThread[] = this.store.getState().visible.map((thread) => ({
      id: thread.id,
      anchor: thread.anchor && { lineStart: thread.anchor.lineStart, lineEnd: thread.anchor.lineEnd, quotedText: thread.anchor.quotedText, exactText: thread.anchor.exactText },
    }));
    this.host.marks.show(this.path, threads, this.ui.selectedId);
  }

  async beginDraft(draft: Draft): Promise<boolean> {
    if (this.ui.posting) return false;
    const { draft: current, draftBody } = this.ui;
    if (current && draftBody.trim() !== "") {
      const same = current.from === draft.from && current.to === draft.to;
      if (same || !(await this.host.discardUnsent(plainQuote(current.quote)))) {
        this.patch({ focusRequests: this.ui.focusRequests + 1 });
        return same;
      }
    }
    this.patch({ draft, draftBody: "", focusRequests: this.ui.focusRequests + 1 });
    return true;
  }

  private focusHandled = 0;

  claimFocus(request: number): boolean {
    if (request <= this.focusHandled) return false;
    this.focusHandled = request;
    return true;
  }

  focusBox(): void {
    this.patch({ focusRequests: this.ui.focusRequests + 1 });
  }

  setDraftBody(draftBody: string): void {
    this.patch({ draftBody });
  }

  cancelDraft(): void {
    this.patch({ draft: null, draftBody: "" });
  }

  select(id: string, from: "card" | "mark" | "field"): void {
    this.patch({ selectedId: id });
    if (from === "mark") void this.host.showPanel();
    this.host.marks.reveal(this.path, id);
    if (from === "card") this.host.afterJump();
  }

  deselect(): void {
    if (this.ui.selectedId !== null) this.patch({ selectedId: null });
  }

  private async locate(draft: Draft): Promise<ThreadAnchorLines | null> {
    const source = await this.host.api.savedSource(this.doc);
    const placed = placeQuote(source, { lineStart: draft.lineStart, lineEnd: draft.lineEnd, exactText: draft.quote });
    return placed ? { lineStart: placed.lineStart, lineEnd: placed.lineEnd } : null;
  }

  private async placeInSavedFile(draft: Draft): Promise<ThreadAnchorLines> {
    const anchor = await this.locate(draft);
    if (!anchor) throw new Error(this.host.isLive(this.path) ? PLUGIN_COMMENT_WORDS.notSavedYet : PLUGIN_COMMENT_WORDS.onlyHere);
    return anchor;
  }

  private async waitForSave(draft: Draft): Promise<ThreadAnchorLines | "timed_out" | "cancelled"> {
    const { everyMs, maxMs } = COMMENT_SAVE_WAIT;
    for (let waited = 0; waited < maxMs; waited += everyMs) {
      await this.host.wait(everyMs);
      if (this.ui.draft !== draft) return "cancelled";
      const found = await this.locate(draft).catch(() => null);
      if (found) return found;
    }
    return "timed_out";
  }

  async postDraft(): Promise<void> {
    const { draft } = this.ui;
    const body = this.ui.draftBody.trim();
    if (this.sending || !draft || body === "") return;
    this.sending = true;
    this.patch({ posting: true });
    let found = this.host.isLive(this.path) ? await this.locate(draft).catch(() => null) : null;
    if (this.host.isLive(this.path) && found === null) {
      this.patch({ waiting: true });
      const outcome = await this.waitForSave(draft);
      this.patch({ waiting: false });
      if (outcome === "timed_out" || outcome === "cancelled") {
        if (outcome === "timed_out") this.host.stay(COMMENT_WORDS.saveTimedOut.title, COMMENT_WORDS.saveTimedOut.description);
        this.sending = false;
        this.patch({ posting: false });
        return;
      }
      found = outcome;
    }
    const place = found;
    const key = `post:${++this.seq}`;
    this.host.marks.follow(this.path, key, { from: draft.from, to: draft.to });
    try {
      this.patch({ draft: null, draftBody: "" });
      const thread = await this.store.createThread({ lineStart: draft.lineStart, lineEnd: draft.lineEnd, body, quotedText: plainQuote(draft.quote) }, () => (place ? Promise.resolve(place) : this.placeInSavedFile(draft)));
      const range = this.host.marks.release(this.path, key);
      if (range) this.host.marks.place(this.path, thread.id, range);
      this.patch({ selectedId: thread.id });
    } catch (error) {
      this.host.marks.release(this.path, key);
      this.patch({ draft, draftBody: body });
      this.host.error(COMMENT_WORDS.postFailedTitle, failureWords(error));
    } finally {
      this.sending = false;
      this.patch({ posting: false });
    }
  }

  async applySuggestion(id: string): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    this.patch({ applyingId: id });
    try {
      const thread = findConversation(this.store.getState().threads, id);
      const key = thread?.id ?? id;
      const currentText = this.host.marks.text(this.path);
      const existing = this.applied.get(key) ?? this.applied.get(id);
      let entry: AppliedSuggestion | undefined;
      if (existing && isAppliedPresent(existing, currentText)) {
        entry = existing;
      } else {
        this.applied.delete(key);
        this.applied.delete(id);
        const beforeText = currentText ?? "";
        const replacement = thread ? extractSuggestionFromComments(thread.displayComments) : null;
        const { anchor } = thread ?? {};
        let status: ApplyStatus = "failed";
        if (anchor && replacement !== null) {
          status = this.host.marks.applyEdit(this.path, { lineStart: anchor.lineStart, lineEnd: anchor.lineEnd, quotedText: anchor.quotedText, exactText: anchor.exactText }, replacement);
        }
        if (status !== "applied") {
          await this.host.alert(COMMENT_WORDS.applyFailedTitle, COMMENT_WORDS.applyFailedBody);
          return;
        }
        const afterText = this.host.marks.text(this.path) ?? "";
        const find = normalizeLineEndings(anchor?.exactText?.trim() || anchor?.quotedText || "");
        const replace = normalizeLineEndings(replacement ?? "");
        entry = {
          snapshot: {
            replaceNeedle: replace,
            beforeReplaceCount: countOccurrences(beforeText, replace),
            afterReplaceCount: countOccurrences(afterText, replace),
            findNeedle: find,
            beforeFindCount: countOccurrences(beforeText, find),
            afterFindCount: countOccurrences(afterText, find),
            sourceReplace: replace,
            beforeSourceCount: countOccurrences(beforeText, replace),
            afterSourceCount: countOccurrences(afterText, replace),
          },
          saved: false,
          savedText: null,
        };
        this.applied.set(key, entry);
      }
      const persist = async (): Promise<boolean> => {
        try {
          await this.host.saveNote(this.path);
          return true;
        } catch (error) {
          this.host.error(COMMENT_WORDS.saveFailedTitle, failureWords(error));
          return false;
        }
      };
      const needsSave = !entry.saved || this.host.marks.text(this.path) !== entry.savedText;
      if (needsSave) {
        if (!(await persist())) return;
        entry.saved = true;
        entry.savedText = this.host.marks.text(this.path);
      }
      const committed = this.host.marks.text(this.path);
      const resolved = await this.store.resolve(id, true);
      if (resolved) {
        this.applied.delete(key);
        this.applied.delete(id);
      }
      if (this.host.marks.text(this.path) !== committed) {
        if (await persist()) {
          entry.saved = true;
          entry.savedText = this.host.marks.text(this.path);
        }
      }
    } finally {
      this.applying = false;
      this.patch({ applyingId: null });
    }
  }
}

export class CommentsHub {
  private readonly notes = new Map<string, NoteComments>();
  private readonly listeners = new Set<() => void>();
  private readonly intents = createLocalIntents();
  private readonly opener: ReviewOpener<PrInfo>;
  private active: string | null = null;
  private stopPolling: (() => void) | null = null;

  constructor(private readonly host: CommentsHost) {
    this.opener = new ReviewOpener<PrInfo>({ wait: (ms) => host.wait(ms), later: (run, ms) => host.later(run, ms) });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  forNote(path: string): NoteComments | null {
    const doc = this.host.documentFor(path);
    const known = this.notes.get(path);
    if (known && doc && docKey(known.doc) === docKey(doc)) return known;
    if (known) {
      const wasActive = this.active === path;
      this.drop(path);
      if (wasActive && doc) queueMicrotask(() => this.setActive(path));
    }
    if (!doc) return null;
    const { api } = this.host;
    const io = api.io(doc, {
      run: (write, onPr) => this.opener.run(docKey(doc), write, { isNotOpen: isReviewNotOpen, start: () => api.startReview(doc), onPr }),
    });
    const note = new NoteComments(path, doc, this.host, new ThreadsStore({ io, me: () => this.host.me(), intents: this.intents, ...(this.host.now ? { now: () => this.host.now!() } : {}) }));
    this.notes.set(path, note);
    note.store.subscribe(() => this.emit());
    note.subscribe(() => this.emit());
    return note;
  }

  openCount(path: string | null): number {
    const note = path === null ? undefined : this.notes.get(path);
    return note ? openThreadCount(note.store.getState().threads) : 0;
  }

  setActive(path: string | null): void {
    if (path === this.active && (this.stopPolling !== null || path === null)) return;
    this.stopPolling?.();
    this.stopPolling = null;
    this.active = path;
    this.emit();
    if (path === null || !this.host.signedIn()) return;
    const note = this.forNote(path);
    if (note) this.stopPolling = note.store.startPolling(createPollGateFor(this.host.signals), (run, ms) => this.host.every(run, ms));
  }

  heard(event: LiveEvent): void {
    const note = this.active === null ? undefined : this.notes.get(this.active);
    if (note && concernsDocument(event, note.doc.path)) note.store.heard(event);
  }

  catchUp(first = false): void {
    if (this.active !== null) this.notes.get(this.active)?.store.catchUp(first);
  }

  refresh(): void {
    const { active } = this;
    this.active = null;
    this.setActive(active);
  }

  reset(): void {
    const { active } = this;
    this.stopPolling?.();
    this.stopPolling = null;
    for (const path of this.notes.keys()) this.host.marks.forget(path);
    this.notes.clear();
    this.intents.clear();
    this.active = null;
    this.emit();
    this.setActive(active);
  }

  private drop(path: string): void {
    this.notes.delete(path);
    this.host.marks.forget(path);
    if (this.active === path) {
      this.active = null;
      this.stopPolling?.();
      this.stopPolling = null;
    }
  }

  forget(path: string): void {
    this.drop(path);
    this.emit();
  }

  async startComment(path: string, selection: { quote: string; from: number; to: number; lineStart: number; lineEnd: number }): Promise<boolean> {
    const note = this.forNote(path);
    if (!note || looseText(selection.quote) === "") return false;
    const shown = Promise.resolve(this.host.showPanel());
    const started = await note.beginDraft(selection);
    await shown;
    if (started) note.focusBox();
    return started;
  }
}
