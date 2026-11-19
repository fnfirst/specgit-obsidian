import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf } from "../changes/cache";
import type { Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { Budget } from "../disk/diff";
import { eolOf, toLf, withEol } from "../disk/line-endings";
import { reconcile } from "../disk/reconcile";
import type { ReviewRequest } from "../editor/services";
import { type DocumentRef, noteName } from "../mapping";
import type { NoticeHandle } from "../notices";
import type { Activity } from "./activity";
import { type Case, draftCase, type Draft, draftKey, type Ended, type FileFacts, follows, isClean, type LeftAlone, type StayDrafts } from "./draft-state";
import type { BranchFile, MainFile } from "../auth/git-copy";
import { DraftDeletes } from "./draft-deletes";
import { DraftRenames, RENAME_HOLD_MS } from "./draft-renames";
import type { End } from "./ends";
import { FIRST_WAIT_MS, MAX_WAIT_MS, READS_PER_PASS, TEXTS_PER_PASS } from "./inbound";
import { changeKey } from "./outbound";
import type { StayState } from "./state";
import type { StayPorts } from "./types";
import { CHOICE_WORDS, DRAFT_SAID } from "./words";

export const RECENT_MS = 5_000;

export const ENDED_AFTER_MS = 60_000;

export const UNLEVEL_ENDED_WAITS_MS = [10_000, 20_000, 40_000, 80_000, 120_000] as const;

export const TRANSIT_MS = 2_000;

export { RENAME_HOLD_MS };

export interface DraftContext {
  ports: StayPorts;
  state: StayState;
  activity: Activity;

  current(): boolean;
}

export interface DraftPass {

  changed: number;

  more: boolean;

  wake: number | null;
}

export class DraftInbound {
  private reads = 0;
  private cut = false;
  private wake: number | null = null;

  private readonly unlevel = new Map<string, { strikes: number; until: number }>();
  private looked: Looked | null = null;

  private readonly waiting = new Map<string, { until: number; strikes: number }>();

  private readonly endWaiting = new Map<string, { until: number; strikes: number }>();

  private readonly toldConflict = new Map<string, string>();

  private readonly noticed = new Set<string>();

  private readonly toldOffer = new Map<string, string>();

  private initial: Map<string, string> | null = null;

  private readonly initialOffered = new Set<string>();

  private offerNotice: NoticeHandle | null = null;

  private offerSaid = 0;

  private readonly attachmentsFor = new Map<string, string>();

  private readonly endedMemo = {
    get: (path: string): { sent: string; ended: Ended } | undefined => this.ctx.state.data.endedOwn?.[path],
    has: (path: string): boolean => this.ctx.state.data.endedOwn?.[path] !== undefined,
    set: (path: string, one: { sent: string; ended: Ended }): void => void ((this.ctx.state.data.endedOwn ??= {})[path] = one),
    delete: (path: string): void => void delete this.ctx.state.data.endedOwn?.[path],
    keys: (): string[] => Object.keys(this.ctx.state.data.endedOwn ?? {}),
  };

  pending(path: string): boolean {
    return this.endedMemo.has(path);
  }

  private ends = new Map<string, End | "unknown">();

  private endsAsked = new Set<string>();

  private texts = new Map<string, string>();

  private draftTexts = new Map<string, string>();

  private draftsDeferred = new Set<string>();

  private known: (sha: string) => string | undefined = () => undefined;

  private readonly awaiting = new Map<string, { sent: string; to: string | null; agreed: string }>();

  private readonly deciding = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();

  private readonly renames: DraftRenames;

  private readonly deletes: DraftDeletes;

  constructor(private readonly ctx: DraftContext) {
    this.renames = new DraftRenames(ctx, {
      ready: (path, spend, pairing) => this.ready(path, spend, pairing),
      wait: (path) => this.wait(path),
      leftAlone: (looked, path) => this.leftAlone(looked, path),
      reads: () => this.reads,
      spendRead: () => void this.reads++,
      cutPass: () => void (this.cut = true),
      awaiting: this.awaiting,
    });
    this.deletes = new DraftDeletes(ctx, {
      wait: (path) => this.wait(path),
      settled: (path) => this.settled(path),
      forgetEnded: (path) => this.endedMemo.delete(path),
    });
  }

  stop(): void {
    this.abort.abort();
    this.offerNotice?.hide();
    this.offerNotice = null;
  }

  tellConflict(path: string, blob: string | null): void {
    if (blob !== null && this.toldConflict.get(path) === blob) return;
    if (blob !== null) this.toldConflict.set(path, blob);
    if (this.noticed.has(path)) return;
    this.noticed.add(path);

    if (!this.ctx.ports.aware()) {
      this.ctx.ports.notify(DRAFT_SAID.conflict(noteName(path)), { label: DRAFT_SAID.chooseButton, run: () => this.settleNow(path), lasting: true });
      return;
    }
    this.ctx.ports.choice?.(path, { words: CHOICE_WORDS.draft, label: CHOICE_WORDS.choose, run: () => this.settleNow(path) });
    this.ctx.ports.notify(DRAFT_SAID.conflict(noteName(path)), { label: CHOICE_WORDS.show, run: () => this.ctx.ports.openStatus?.(), lasting: true });
  }

  private clearConflict(path: string): void {
    this.toldConflict.delete(path);
    this.noticed.delete(path);
    this.ctx.ports.choice?.(path, null);
  }

  release(path: string): void {
    this.waiting.delete(path);
    this.endWaiting.delete(path);
  }

  told(path: string, blob: string | null): boolean {
    return blob !== null && this.toldConflict.get(path) === blob;
  }

  async readOne(looked: Looked, path: string): Promise<{ changed: number; wake: number | null }> {
    const draft = looked.drafts?.byPath.get(path);
    this.looked = looked;
    this.reads = 0;
    this.cut = false;
    this.wake = null;
    if (!looked.drafts) return { changed: 0, wake: null };

    if (draft && !looked.files.has(path) && this.renames.mayBeRename(looked, looked.drafts.byPath, path, draft) && this.renames.holding(path)) {
      this.ctx.ports.lookAgain();
      return { changed: 0, wake: null };
    }
    this.forgetReads();

    const moved = draft ? { ...draft, blob: "" } : null;
    const changed = ((await this.one(looked, path, moved, looked.drafts.level)) ? 1 : 0) + (await this.deletes.flush());
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, wake: this.wake };
  }

  async readEnded(looked: Looked, path: string): Promise<{ changed: number; wake: number | null }> {
    this.forgetReads();
    this.looked = looked;
    this.reads = 0;
    this.cut = false;
    this.wake = null;
    const changed = ((await this.one(looked, path, null, true)) ? 1 : 0) + (await this.deletes.flush());
    this.tellClosed();
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, wake: this.wake };
  }

  keepDeleted(looked: Looked, path: string, deletedAt: number): void {
    this.deletes.keep(looked, path, deletedAt);
  }

  forgetDeleted(path: string): void {
    this.deletes.forget(path);
  }

  tellDeleted(): void {
    this.deletes.tellKept();
  }

  private forgetReads(): void {
    this.ends = new Map();
    this.endsAsked = new Set();
    this.texts = new Map();
    this.draftTexts = new Map();
    this.draftsDeferred = new Set();
  }

  async run(looked: Looked, known: (sha: string) => string | undefined = () => undefined): Promise<DraftPass> {
    const drafts = looked.drafts;
    this.looked = looked;
    this.known = known;
    this.reads = 0;
    this.cut = false;
    this.wake = null;

    let changed = this.keepAwaiting(looked);

    if (!drafts) return { changed, more: false, wake: null };
    this.noteInitial(looked, drafts);
    await this.backfill(looked);
    this.deletes.dropGone(looked);
    this.renames.dropSettled(looked, drafts.byPath);
    const renamed = await this.renames.pair(looked, drafts.byPath);
    changed += renamed.changed;
    const paths = new Set<string>([...drafts.byPath.keys(), ...this.endedMemo.keys(), ...[...looked.files].filter(([, entry]) => entry.sent !== undefined).map(([path]) => path)]);
    await this.readEnds(looked, paths, drafts);
    await this.readDrafts(looked, paths, drafts);

    for (const path of [...this.unlevel.keys()]) if (!paths.has(path)) this.unlevel.delete(path);
    for (const path of paths) {
      if (!this.ctx.current()) break;

      if (renamed.paths.has(path)) continue;
      if (await this.one(looked, path, drafts.byPath.get(path) ?? null, drafts.level)) changed++;
    }
    changed += await this.deletes.flush();
    this.tellOffers(drafts);
    this.tellClosed();
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, more: this.cut, wake: this.wake };
  }

  private keepAwaiting(looked: Looked): number {
    let kept = 0;
    for (const [path, record] of [...this.awaiting]) {
      const entry = looked.files.get(path);
      if (!entry) continue;
      this.awaiting.delete(path);
      if (entry.sha !== record.agreed) continue;
      this.ctx.ports.agreed(path, record);
      kept++;
    }
    return kept;
  }

  private async backfill(looked: Looked): Promise<void> {
    for (const [path, entry] of looked.files) {
      if (entry.sent === undefined || agreedOf(entry) !== undefined || !this.ctx.current()) continue;
      const text = await this.ctx.ports.vault.read(path);
      if (text === null || gitBlobShaOfText(text) !== entry.sha) continue;
      if (gitBlobShaOfText(toLf(text)) === entry.sent) this.ctx.ports.agreedAs(path, entry.sha);
    }
  }

  private facts(looked: Looked, path: string): FileFacts {
    const entry = looked.files.get(path);
    const repoSha = looked.repo.get(path);
    const agreed = entry ? agreedOf(entry) : undefined;
    return {
      present: entry !== undefined,
      ...(entry ? { sha: entry.sha } : {}),
      ...(entry?.sent !== undefined ? { sent: entry.sent } : {}),
      ...(entry?.sentTo !== undefined ? { sentTo: entry.sentTo } : {}),
      ...(agreed !== undefined ? { agreed } : {}),
      unchanged: entry ? unchangedHere(entry) : false,
      deletedHere: looked.deleted.some((gone) => gone.path === path),
      published: repoSha !== undefined,
      publishedMoved: entry !== undefined && repoSha !== undefined && entry.base !== null && repoSha !== entry.base,
    };
  }

  private async leftAlone(looked: Looked, path: string): Promise<LeftAlone | null> {
    const { ports, activity } = this.ctx;
    const doc = ports.documentFor(path);
    if (doc && ports.disconnected(doc)) return "disconnected";
    if (ports.phaseOf(path) !== "local") return "live";
    if (activity.isSuspect(path) || activity.isGit(path)) return "tool";
    const entry = looked.files.get(path);
    if (entry) {
      const age = ports.now() - entry.mtime;
      if (age < RECENT_MS) {
        this.wake = Math.min(this.wake ?? Number.POSITIVE_INFINITY, RECENT_MS - age + 50);
        return "recent";
      }
    }
    return entry && (await ports.vault.hasUnsavedText(path)) ? "unsaved" : null;
  }

  private async readEnds(looked: Looked, paths: ReadonlySet<string>, drafts: NonNullable<Looked["drafts"]>): Promise<void> {
    const { ports } = this.ctx;
    this.ends = new Map();
    this.endsAsked = new Set();
    this.texts = new Map();
    if (!ports.reviewEnds || !drafts.level) return;
    const asked: Array<{ path: string; doc: DocumentRef; number: number; group: boolean }> = [];
    for (const path of paths) {
      const entry = looked.files.get(path);
      const doc = ports.documentFor(path);
      const number = /^(?:pr|group):(\d+)$/.exec(entry?.sentTo ?? "")?.[1];
      if (!doc || !entry || entry.sent === undefined || number === undefined || drafts.byPath.has(path) || this.endedMemo.has(path) || ports.inGroup(path)) continue;
      if (ports.now() - (entry.sentAt ?? 0) <= ENDED_AFTER_MS || !this.ready(path, false)) continue;
      const facts = this.facts(looked, path);
      const kind = draftCase({ file: facts, draft: null, login: ports.login(), policy: ports.policy(), leftAlone: null, ended: null }).kind;
      if (kind === "none" || kind === "wait") asked.push({ path, doc, number: Number(number), group: entry.sentTo?.startsWith("group:") === true });
    }
    if (asked.length === 0) return;
    const answer = await ports.reviewEnds(asked.map(({ doc, number, group }) => ({ doc, number, ...(group ? { group: true } : {}) })));
    if (!this.ctx.current() || answer === null) return;
    for (const { path, number } of asked) {
      const end = answer.get(number);
      if (end === undefined) this.endsAsked.add(path);
      else this.ends.set(path, end);
    }

    if (!ports.blobTexts) return;
    const wanted: Array<{ doc: DocumentRef; sha: string }> = [];
    const seen = new Set<string>();
    for (const { path, doc } of asked) {
      const end = this.ends.get(path);
      const sha = looked.repo.get(path);
      if ((end !== "published" && end !== "discarded") || sha === undefined || seen.has(sha) || this.known(sha) !== undefined || sha === looked.files.get(path)?.sha) continue;
      seen.add(sha);
      wanted.push({ doc, sha });
      if (wanted.length >= TEXTS_PER_PASS) break;
    }
    if (wanted.length > 0) this.texts = await ports.blobTexts(wanted);
  }

  private async readDrafts(looked: Looked, paths: ReadonlySet<string>, drafts: NonNullable<Looked["drafts"]>): Promise<void> {
    const { ports } = this.ctx;
    this.draftTexts = new Map();
    this.draftsDeferred = new Set();

    if (!ports.draftTexts || !drafts.level) return;
    const asked: Array<{ doc: DocumentRef; sha: string }> = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const draft = drafts.byPath.get(path);
      const doc = ports.documentFor(path);
      if (!draft || !draft.blob || !doc || (ports.inGroup(path) && draft.inGroup !== true) || seen.has(draft.blob) || !this.ready(path, false)) continue;
      const entry = looked.files.get(path);

      if (entry?.sent !== undefined && !(drafts.asOf !== undefined && drafts.asOf > (entry.sentAt ?? 0) + TRANSIT_MS)) continue;
      const kind = draftCase({ file: this.facts(looked, path), draft, login: ports.login(), policy: this.policyFor(path, draft), leftAlone: null, ended: null }).kind;
      if (kind !== "take" && kind !== "create" && kind !== "merge") continue;

      if (asked.length >= TEXTS_PER_PASS) {
        this.draftsDeferred.add(path);
        continue;
      }
      seen.add(draft.blob);
      asked.push({ doc, sha: draft.blob });
    }
    if (asked.length > 0) this.draftTexts = await ports.draftTexts(asked);
  }

  private draftOf(draft: Draft): BranchFile | null {
    const text = draft.blob ? this.draftTexts.get(draft.blob) : undefined;
    return text === undefined || !draft.blob ? null : { kind: "file", text, sha: draft.blob };
  }

  private mainOf(path: string): MainFile | null {
    const sha = this.looked?.repo.get(path);
    const text = sha === undefined ? undefined : (this.texts.get(sha) ?? this.known(sha));
    return sha !== undefined && text !== undefined ? { kind: "file", text, sha } : null;
  }

  private ready(path: string, spend = true, pairing = false): boolean {
    const waited = this.waiting.get(path);
    if (waited && this.ctx.ports.now() < waited.until) return false;

    const endWaited = pairing ? undefined : this.endWaiting.get(path);
    if (endWaited && this.ctx.ports.now() < endWaited.until) return false;
    if (spend && this.reads >= READS_PER_PASS) {
      this.cut = true;
      return false;
    }
    return true;
  }

  private wait(path: string): void {
    const before = this.waiting.get(path);
    const strikes = before ? before.strikes + 1 : 0;
    this.waiting.set(path, { strikes, until: this.ctx.ports.now() + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** strikes) });
  }

  private waitEnd(path: string): void {
    const before = this.endWaiting.get(path);
    const strikes = before ? before.strikes + 1 : 0;
    this.endWaiting.set(path, { strikes, until: this.ctx.ports.now() + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** strikes) });
  }

  private settled(path: string): void {
    this.waiting.delete(path);
    this.endWaiting.delete(path);
  }

  private async one(looked: Looked, path: string, draft: Draft | null, level: boolean): Promise<boolean> {
    const { ports } = this.ctx;
    const doc = ports.documentFor(path);

    if (!doc || (ports.inGroup(path) && draft?.inGroup !== true)) {
      this.unlevel.delete(path);
      return false;
    }

    const same = looked.files.get(path);
    if (draft && draft.blob !== null && same !== undefined && same.sha === draft.blob && !(same.sent === draft.blob && agreedOf(same) === same.sha && same.sentTo === (draftKey(draft) ?? undefined)) && follows(draft, ports.login(), same.sentTo, this.policyFor(path, draft)) && (await this.leftAlone(looked, path)) === null) {
      const to = draftKey(draft);
      ports.agreed(path, { sent: draft.blob, to, agreed: same.sha });

      Object.assign(same, { sent: draft.blob, agreed: same.sha, ...(to === null ? {} : { sentTo: to }) });
      this.settled(path);
      this.clearConflict(path);
      this.unlevel.delete(path);
      return false;
    }
    const memo = this.endedMemo.get(path);
    const facts = this.facts(looked, path);
    const input = { file: memo && facts.sent === undefined ? { ...facts, sent: memo.sent } : facts, draft, login: ports.login(), policy: draft ? this.policyFor(path, draft) : ports.policy(), leftAlone: null, ended: memo?.ended ?? null } as const;
    let answer: Case = draftCase(input);
    let ended: Ended | null = memo?.ended ?? null;
    const entry = looked.files.get(path);

    if (draft || entry?.sent === undefined || level || memo || (answer.kind !== "none" && answer.kind !== "wait")) this.unlevel.delete(path);
    else {
      const now = ports.now();
      let known = this.unlevel.get(path);

      if (!known || (now >= known.until && known.strikes < UNLEVEL_ENDED_WAITS_MS.length)) {
        const strikes = known ? known.strikes : 0;
        known = { strikes: strikes + 1, until: now + UNLEVEL_ENDED_WAITS_MS[strikes]! };
        this.unlevel.set(path, known);
      }
      if (now < known.until) this.wake = Math.min(this.wake ?? Number.POSITIVE_INFINITY, known.until - now + 50);
    }

    if (!draft && entry?.sent !== undefined && level && !memo && ports.now() - (entry.sentAt ?? 0) <= ENDED_AFTER_MS && (answer.kind === "none" || answer.kind === "wait")) {
      this.wake = Math.min(this.wake ?? Number.POSITIVE_INFINITY, ENDED_AFTER_MS - (ports.now() - (entry.sentAt ?? 0)) + 50);
    }
    if (!draft && entry?.sent !== undefined && level && ports.now() - (entry.sentAt ?? 0) > ENDED_AFTER_MS && (answer.kind === "none" || answer.kind === "wait")) {
      const together = this.ends.get(path);
      if (!this.ready(path, together === undefined && !this.endsAsked.has(path))) return false;
      if (together === undefined && !this.endsAsked.has(path)) this.reads++;
      const end = together ?? (this.endsAsked.has(path) ? "unknown" : await ports.reviewEnd(doc, entry?.sentTo?.startsWith("group:") === true));
      if (!this.ctx.current()) return false;
      if (end === "unknown" || end === "open") {
        this.waitEnd(path);
        return false;
      }

      if (end === "closed" || end === "closedUnnamed") return this.keepClosed(looked, path, end === "closedUnnamed");
      ended = end === "published" ? "published" : "discarded";
      answer = draftCase({ ...input, ended });

      if (answer.kind === "end-own" && entry?.sent !== undefined) {
        this.endedMemo.set(path, { sent: entry.sent, ended });
        ports.agreed(path, null);
      }
    }

    const alone = draft && answer.kind === "settled" ? await this.leftAlone(looked, path) : null;
    if (draft && answer.kind === "settled" && (alone === null || alone === "live")) await this.attachments(path, doc, draft, alone === null);

    if (answer.kind === "settled" || answer.kind === "send" || answer.kind === "none") this.clearConflict(path);
    if (!["offer", "take", "create", "merge", "settle", "restore", "end-own"].includes(answer.kind)) return false;

    if (answer.kind === "end-own" && input.file.publishedMoved) return false;
    if ((await this.leftAlone(looked, path)) !== null || !this.ctx.current()) return false;

    if (answer.kind === "offer") return this.offer(path, looked.drafts?.byPath.get(path) ?? draft);
    const batched = (["settle", "restore", "end-own"].includes(answer.kind) && this.mainOf(path) !== null) || (draft !== null && ["take", "create", "merge"].includes(answer.kind) && this.draftOf(draft) !== null);
    if (this.draftsDeferred.has(path) && ["take", "create", "merge"].includes(answer.kind)) {
      this.cut = true;
      return false;
    }
    if (!this.ready(path, !batched)) return false;
    try {
      switch (answer.kind) {
        case "take": {
          const taken = await this.take(path, doc, looked, draft!);
          if (!this.waiting.has(path)) await this.attachments(path, doc, draft!);
          return taken;
        }
        case "create": {
          const made = await this.create(path, doc, draft!);
          if (!this.waiting.has(path)) await this.attachments(path, doc, draft!);
          return made;
        }
        case "merge":
          return await this.classify(path, doc, looked, draft!);
        default:
          return await this.end(path, doc, looked, answer.kind as "settle" | "restore" | "end-own", ended === "discarded");
      }
    } catch {

      this.ctx.activity.notWritten(path);
      ports.diagnose("a draft could not be brought into a note");
      this.wait(path);
      return false;
    }
  }

  private readonly closedNow: Array<{ name: string; unnamed: boolean }> = [];

  private keepClosed(looked: Looked, path: string, unnamed: boolean): boolean {
    const { ports, state } = this.ctx;
    const entry = looked.files.get(path);
    ports.agreed(path, null);
    if (entry !== undefined && entry.sha !== looked.repo.get(path)) {
      (state.data.editsHeld ??= {})[path] = entry.sha;
      (state.data.heldWhy ??= {})[path] = "closedElsewhere";
      this.closedNow.push({ name: noteName(path), unnamed });
    }
    this.settled(path);
    return false;
  }

  private tellClosed(): void {
    if (this.closedNow.length === 0) return;
    const closed = this.closedNow.splice(0);

    this.ctx.ports.notify(DRAFT_SAID.closedElsewhere(closed.map((one) => one.name), closed.some((one) => one.unnamed) ? "unknown" : "someone else"), { label: DRAFT_SAID.closedElsewhereButton, run: () => this.ctx.ports.openStatus?.(), lasting: true });
  }

  private async attachments(path: string, doc: DocumentRef, draft: Draft, replace = true): Promise<void> {
    const { ports } = this.ctx;
    if (!ports.bringAttachments || draft.blob === null || this.attachmentsFor.get(path) === draft.blob) return;
    const text = await ports.vault.read(path);
    if (text === null || !this.ctx.current()) return;
    this.attachmentsFor.set(path, draft.blob);
    try {
      await ports.bringAttachments(doc, draft.branch, path, text, (words) => ports.attachmentRow?.(path, words), { replace });
    } catch {
      ports.diagnose("the attachments of a draft could not be brought in");
    }
  }

  private offer(path: string, draft: Draft | null): boolean {
    if (!draft || draft.blob === null || this.toldOffer.get(path) === draft.branch) return false;
    this.toldOffer.set(path, draft.branch);
    this.initialOffered.add(path);
    return false;
  }

  policyFor(path: string, draft: Pick<Draft, "blob">): StayDrafts {
    const policy = this.ctx.ports.policy();
    return policy === "everyone" && draft.blob !== null && this.initial?.get(path) === draft.blob ? "mine" : policy;
  }

  private noteInitial(looked: Looked, drafts: NonNullable<Looked["drafts"]>): void {
    if (this.initial !== null) return;
    const { ports } = this.ctx;
    this.initial = new Map();
    if (ports.policy() !== "everyone") return;
    for (const [path, draft] of drafts.byPath) {
      if (draft.blob === null || draft.inGroup === true) continue;
      const sentTo = looked.files.get(path)?.sentTo;
      if (!follows(draft, ports.login(), sentTo, "mine") && follows(draft, ports.login(), sentTo, "everyone")) this.initial.set(path, draft.blob);
    }
  }

  private tellOffers(drafts: NonNullable<Looked["drafts"]>): void {
    if (drafts.level) {
      for (const path of [...this.initialOffered]) {
        if (drafts.byPath.get(path)?.blob != null) continue;
        this.initialOffered.delete(path);
        this.initial?.delete(path);
        this.toldOffer.delete(path);
      }
    }
    this.showOffers();
  }

  private showOffers(): void {
    const count = this.initialOffered.size;
    this.lowerTold(count);
    if (count === 0) {
      this.offerNotice?.hide();
      this.offerNotice = null;
      return;
    }

    const aware = this.ctx.ports.aware();
    const words = aware ? DRAFT_SAID.offerTogether(count) : DRAFT_SAID.offerTogetherPlain(count);
    if (this.offerNotice?.shown()) {
      this.offerNotice(words);
      this.offerSaid = count;
      return;
    }

    if (this.offerNotice && count <= this.offerSaid) {
      this.offerSaid = count;
      return;
    }
    this.offerSaid = count;

    if (count <= (this.ctx.state.data.offerTold ?? 0)) return;
    this.ctx.state.data.offerTold = count;
    const action = aware ? { label: DRAFT_SAID.offerTogetherButton, run: () => this.ctx.ports.openStatus?.(), lasting: true } : { label: DRAFT_SAID.offerTogetherPlainButton, run: () => this.addAllOffered(), lasting: true };
    this.offerNotice = this.ctx.ports.notify(words, action) ?? null;
  }

  private lowerTold(count: number): void {
    const { data } = this.ctx.state;
    if (data.offerTold !== undefined && count < data.offerTold) data.offerTold = count;
  }

  offered(): readonly string[] {
    return [...this.initialOffered];
  }

  dropOffer(path: string): void {
    if (!this.initialOffered.delete(path)) return;
    this.initial?.delete(path);
    const left = this.initialOffered.size;
    this.lowerTold(left);
    if (left === 0) {
      this.offerNotice?.hide();
      this.offerNotice = null;
    } else this.offerNotice?.(this.ctx.ports.aware() ? DRAFT_SAID.offerTogether(left) : DRAFT_SAID.offerTogetherPlain(left));
  }

  addAllOffered(): void {

    if (this.ctx.ports.policy() !== "everyone") {
      for (const path of [...this.initialOffered]) this.settleNow(path);
      return;
    }
    for (const path of this.initialOffered) this.initial?.delete(path);
    this.initialOffered.clear();
    this.lowerTold(0);
    this.offerNotice?.hide();
    this.offerNotice = null;
    this.ctx.ports.lookAgain();
  }

  livened(isLive: (path: string) => boolean): void {
    for (const path of this.initialOffered) if (isLive(path)) this.dropOffer(path);
  }

  addNow(looked: Looked, path: string): void {
    this.looked = looked;
    this.settleNow(path);
  }

  private async take(path: string, doc: DocumentRef, looked: Looked, draft: Draft): Promise<boolean> {
    const { ports, activity } = this.ctx;
    const entry = looked.files.get(path)!;
    const together = this.draftOf(draft);
    if (together === null) this.reads++;
    const there = together ?? (await ports.draftFile(doc, draft.branch));
    if (!this.ctx.current()) return false;
    if (there.kind !== "file") {
      this.wait(path);
      return false;
    }
    const mine = await ports.vault.read(path);
    if (mine === null || gitBlobShaOfText(mine) !== entry.sha) return false;
    let text = mine;

    if (toLf(mine) !== toLf(there.text)) {
      text = withEol(toLf(there.text), eolOf(mine));
      activity.ownWrite(path);

      const written = await ports.vault.process(path, (current) => (current === mine ? text : null));
      if (written !== "written") {
        activity.notWritten(path);
        this.wait(path);
        return false;
      }
    }

    ports.agreed(path, { sent: there.sha, to: draftKey(draft), agreed: gitBlobShaOfText(text) });
    this.settled(path);
    this.clearConflict(path);
    return text !== mine;
  }

  private async create(path: string, doc: DocumentRef, draft: Draft): Promise<boolean> {
    const { ports, activity, state } = this.ctx;
    const together = this.draftOf(draft);
    if (together === null) this.reads++;
    const there = together ?? (await ports.draftFile(doc, draft.branch));
    if (!this.ctx.current()) return false;
    if (there.kind !== "file") {
      this.wait(path);
      return false;
    }
    activity.ownWrite(path);
    if ((await ports.vault.create(path, there.text)) !== "created") {
      activity.notWritten(path);
      this.wait(path);
      return false;
    }

    state.data.committed.push(changeKey({ kind: "new", path }));
    this.awaiting.set(path, { sent: there.sha, to: draftKey(draft), agreed: gitBlobShaOfText(there.text) });
    this.settled(path);
    return true;
  }

  private async classify(path: string, doc: DocumentRef, looked: Looked, draft: Draft): Promise<boolean> {
    const { ports } = this.ctx;
    const entry = looked.files.get(path)!;
    if (draft.blob !== null && this.toldConflict.get(path) === draft.blob) return false;
    const together = this.draftOf(draft);
    this.reads += together === null ? 2 : 1;
    const there = together ?? (await ports.draftFile(doc, draft.branch));
    if (!this.ctx.current()) return false;
    if (there.kind !== "file") {
      this.wait(path);
      return false;
    }
    const mine = await ports.vault.read(path);
    if (mine === null) return false;

    const base = await ports.blobText(doc, entry.sent!);
    if (base === null) {
      this.wait(path);
      return false;
    }
    const joined = reconcile({ editor: toLf(mine), room: toLf(there.text), base: toLf(base), baseIsGit: false, emptied: false, git: there.text, readOnly: false }, new Budget(400));
    if (joined.kind === "review") this.tellConflict(path, there.sha);
    else this.clearConflict(path);
    this.settled(path);
    return false;
  }

  private async end(path: string, doc: DocumentRef, looked: Looked, kind: "settle" | "restore" | "end-own", discarded: boolean, choose = false): Promise<boolean> {
    const { ports, activity, state } = this.ctx;
    const entry = looked.files.get(path)!;
    const batched = this.mainOf(path);
    if (batched === null) this.reads++;
    const main = batched ?? (await ports.gitFile(doc));
    if (!this.ctx.current()) return false;
    if (main.kind === "unreadable") {
      this.wait(path);
      return false;
    }

    if (main.kind === "absent") {

      if (this.renames.moving(looked, path, entry.sha)) {
        this.wait(path);
        return false;
      }
      await this.deletes.absentMain(path, doc, entry.sha, looked, kind);
      return false;
    }
    const mine = await ports.vault.read(path);
    if (mine === null || gitBlobShaOfText(mine) !== entry.sha) return false;
    let target = main.text;
    if (kind === "end-own") {
      this.reads++;
      const base = await ports.blobText(doc, this.endedMemo.get(path)?.sent ?? entry.sent!);
      const joined = reconcile({ editor: toLf(mine), room: toLf(main.text), base: base === null ? null : toLf(base), baseIsGit: false, emptied: false, git: main.text, readOnly: false }, new Budget(400));
      if (joined.kind === "review") {

        if (!choose) {
          this.tellConflict(path, `ended|${main.sha}`);
          return false;
        }
        const chosen = await ports.chooseWhatToKeep({ name: noteName(path), regions: joined.regions, fromBase: joined.fromBase, other: "github", settle: () => null, signal: this.abort.signal });
        if (chosen === null || !this.ctx.current()) return false;
        target = chosen;
      } else if (joined.kind !== "text") {
        this.wait(path);
        return false;
      } else target = joined.text;
    }
    const text = withEol(toLf(target), eolOf(mine));
    const same = toLf(text) === toLf(mine);
    if (!same) {
      activity.ownWrite(path);
      const written = await ports.vault.process(path, (current) => (current === mine ? text : null));
      if (written !== "written") {
        activity.notWritten(path);
        this.wait(path);
        return false;
      }
    }

    ports.recordBase(path, doc, toLf(main.text), main.text);
    ports.rebase(path, main.sha);
    if (state.data.seen) state.data.seen[path] = main.sha;
    ports.agreed(path, null);
    this.endedMemo.delete(path);

    if (kind === "end-own" && discarded) {
      (state.data.editsHeld ??= {})[path] = gitBlobShaOfText(same ? mine : text);
      (state.data.heldWhy ??= {})[path] = "ended";
    }
    this.settled(path);
    this.clearConflict(path);
    if (kind === "restore" && !same) ports.notify(DRAFT_SAID.discarded(noteName(path)));
    return !same;
  }

  private settleNow(path: string): void {

    this.dropOffer(path);
    const looked = this.looked;
    if (!looked || !this.ctx.current() || this.deciding.has(path)) return;
    const draft = looked.drafts?.byPath.get(path);
    const doc = this.ctx.ports.documentFor(path);
    if (!doc) return;
    if (!draft) {

      if (looked.files.get(path)?.sent === undefined && !this.endedMemo.has(path)) return;
      this.deciding.add(path);
      this.queue = this.queue.then(async () => {
        try {
          if (this.ctx.current() && !this.abort.signal.aborted) await this.end(path, doc, looked, "end-own", false, true);
          this.ctx.ports.lookAgain();
        } catch {
          this.ctx.ports.diagnose("a choice between a note and the published version could not be applied");
        } finally {
          this.deciding.delete(path);
        }
      });
      return;
    }
    this.deciding.add(path);
    this.queue = this.queue.then(async () => {
      const { ports, activity } = this.ctx;
      try {
        if (!this.ctx.current() || this.abort.signal.aborted) return;
        const there = await ports.draftFile(doc, draft.branch);
        const mine = await ports.vault.read(path);
        if (there.kind !== "file" || mine === null || !this.ctx.current()) return;
        const entry = looked.files.get(path);
        const base = entry?.sent !== undefined ? await ports.blobText(doc, entry.sent) : null;
        const joined = reconcile({ editor: toLf(mine), room: toLf(there.text), base: base === null ? null : toLf(base), baseIsGit: false, emptied: false, git: there.text, readOnly: false }, new Budget(400));

        const clean = entry !== undefined && gitBlobShaOfText(mine) === entry.sha && isClean({ sha: entry.sha, ...(agreedOf(entry) !== undefined ? { agreed: agreedOf(entry)! } : {}), unchanged: unchangedHere(entry) });
        let chosen: string | null;
        if (clean) chosen = there.text;
        else if (joined.kind === "text") chosen = joined.text;
        else if (joined.kind === "review") {
          const other = draft.by !== null && draft.by.toLowerCase() !== ports.login().toLowerCase() ? { teammate: draft.by } : ("github" as const);
          const request: ReviewRequest = { name: noteName(path), regions: joined.regions, fromBase: joined.fromBase, other, settle: () => null, signal: this.abort.signal };
          chosen = await ports.chooseWhatToKeep(request);
        } else return;

        if (chosen === null || !this.ctx.current()) return;
        const text = withEol(toLf(chosen), eolOf(mine));
        if (text !== mine) {
          activity.ownWrite(path);
          if ((await ports.vault.process(path, (current) => (current === mine ? text : null))) !== "written") {
            activity.notWritten(path);
            return;
          }
        }
        const holdsDraft = toLf(text) === toLf(there.text);
        ports.agreed(path, { sent: there.sha, to: draftKey(draft), ...(holdsDraft ? { agreed: gitBlobShaOfText(text) } : {}) });
        this.clearConflict(path);
        ports.lookAgain();
      } catch {
        ports.diagnose("a choice between a note and its draft could not be applied");
      } finally {
        this.deciding.delete(path);
      }
    });
  }
}
