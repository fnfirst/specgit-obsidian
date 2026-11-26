import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf, clearSent, type CacheEntry } from "../changes/cache";
import { matchedBase } from "../changes/merge-base";
import { unchangedHere } from "../changes/unchanged-here";
import type { Looked } from "../changes/model";
import type { MainFile } from "../auth/git-copy";
import { Budget } from "../disk/diff";
import { follows } from "./draft-state";
import { changesBetween } from "../disk/merge";
import type { Shown } from "../disk/regions";
import { stripBom, toLf, withBomAndEol } from "../disk/line-endings";
import { buildReviewRequest, mergeFile } from "../disk/structured-merge";
import { notWritableBecause } from "../disk/writable";
import type { ReviewPayload } from "../editor/services";
import { CasePathIndex, casePathKey, type DocumentRef, noteName } from "../mapping";
import type { Activity } from "./activity";
import { caseCollisionWords, StayHolds, vaultCaseIndex } from "./holds";
import { BURST_FILES } from "./limits";
import { CHOICE_WORDS, DRAFT_SAID } from "./words";
import type { StayState } from "./state";
import type { StayPorts } from "./types";
import { BackoffWaits, WakeClock } from "./wait";

export const READS_PER_PASS = 40;

export const trashedWords = (names: readonly string[]): string => `Moved ${names.length === 1 ? names[0]! : `${names.length} notes`} to the trash. ${names.length === 1 ? "It was" : "They were"} deleted on GitHub.`;
export const heldDeletesWords = (count: number): string => `${count} notes were deleted on GitHub at once, so none was moved to the trash.`;
export const TEXTS_PER_PASS = 200;
export const FIRST_WAIT_MS = 20_000;
export const MAX_WAIT_MS = 5 * 60_000;
export const STUCK_MS = 60_000;
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const CHOOSE_MATCHED = "This note already matches GitHub. Nothing to resolve.";
const CHOOSE_BLOCKED = "Save or disconnect this note first, then try Choose what to keep again.";
const CHOOSE_UNREADABLE = "specgit couldn't read GitHub's version just now. Try again in a moment.";

const topSegmentKey = (path: string): string => {
  const slash = path.indexOf("/");
  return casePathKey(slash === -1 ? path : path.slice(0, slash));
};

export interface InboundContext {
  ports: StayPorts;
  state: StayState;
  activity: Activity;
  holds?: StayHolds;
  isRemoteRoom?(path: string, sha: string): boolean;
  isOwnBlob?(path: string, sha: string): boolean;
  onSettled?(path: string, sha: string | null): void;
  onRebasedSent?(path: string, sha: string): void;
  current(): boolean;
  onResolved?: (path: string) => void;
}

export interface InboundPass {
  changed: number;
  rescan: boolean;
  more: boolean;
  wake: number | null;
}

type MainText = Extract<MainFile, { kind: "file" }>;

interface Said {
  updated: string[];
  merged: string[];
  created: string[];
  moved: string[];
  trashed: string[];
  came: Array<{ name: string; shown: Shown[] }>;
}

export class Inbound {
  private readonly declined = new Map<string, string>();
  private readonly deciding = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly waiting: BackoffWaits<string>;
  private readonly holds: StayHolds;
  private readonly announced = new Map<string, string>();
  private readonly cues = new Map<string, { sha: string; since: number; told: boolean }>();
  private readonly opening = new Set<string>();
  private readonly settleReason = new Map<string, "matched" | "blocked" | "review">();
  private readonly reviewTold = new Map<string, string>();
  private looked: Looked | null = null;
  private caseIndex = new CasePathIndex();
  private texts = new Map<string, string>();
  private gone: Map<string, boolean> | null = null;
  private reads = 0;
  private cut = false;
  private rescan = false;
  private readonly wake = new WakeClock();
  private readonly releasedDeletes = new Set<string>();
  private announcedDeletes = 0;
  private readonly pendingRenames = new Map<string, { to: string; sha: string }>();
  private readonly deferredUnsaved = new Set<string>();

  constructor(private readonly ctx: InboundContext) {
    this.holds = ctx.holds ?? new StayHolds(ctx.state, ctx.activity, ctx.ports);
    this.waiting = new BackoffWaits(
      () => this.ctx.ports.now(),
      (strikes) => Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** strikes),
    );
  }

  private isPaused(path: string): boolean {
    const doc = this.ctx.ports.documentFor(path);
    return doc !== null && this.ctx.ports.disconnected(doc);
  }

  private isUnchanged(path: string, entry: CacheEntry): boolean {
    return unchangedHere(entry) || this.ctx.isRemoteRoom?.(path, entry.sha) === true;
  }

  private clearPending(path: string): void {
    this.waiting.delete(path);
    this.deferredUnsaved.delete(path);
    this.cues.delete(path);
    this.dropChoice(path);
    this.announced.delete(path);
    this.reviewTold.delete(path);
    this.pendingRenames.delete(path);
  }

  private holdCaseCollision(path: string, sha: string, from?: string): void {
    if (from !== undefined) {
      if (!this.ctx.state.data.kept.includes(from)) this.ctx.state.data.kept.push(from);
      this.settled(from, null);
    }
    this.clearPending(path);
    if (this.holds.holdCaseCollision(path, sha)) this.ctx.ports.notify(caseCollisionWords(noteName(path)));
  }

  release(path: string): void {
    this.waiting.delete(path);
    this.deferredUnsaved.delete(path);
  }

  caughtUp(path: string, repoSha?: string): void {
    this.declined.delete(path);
    if (repoSha !== undefined) {
      delete this.ctx.state.data.endedOwn?.[path];
      this.settled(path, repoSha);
    } else this.clearPending(path);
    this.ctx.onResolved?.(path);
  }

  unsavedPaths(): string[] {
    return [...this.deferredUnsaved];
  }

  stop(): void {
    this.abort.abort();
    this.deferredUnsaved.clear();
  }

  async run(looked: Looked, silent = false): Promise<InboundPass> {
    const { state } = this.ctx;
    const seen = state.data.seen;
    if (!seen) return { changed: 0, rescan: false, more: false, wake: null };
    this.reads = 0;
    this.cut = false;
    this.rescan = false;
    this.wake.reset();
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.holds.pruneCaseCollisions(looked, this.caseIndex);
    const said: Said = { updated: [], merged: [], created: [], moved: [], trashed: [], came: [] };
    const rawAdded = [...looked.repo].filter(([path, sha]) => seen[path] !== sha);
    const added: Array<[string, string]> = [];
    for (const [path, sha] of rawAdded) {
      const entry = looked.files.get(path);
      if (entry?.base === sha) {
        this.settleOwnSent(looked, path, entry, sha);
        this.caughtUp(path, sha);
      } else added.push([path, sha]);
    }
    const removed = Object.entries(seen).filter(([path]) => !looked.repo.has(path));
    const active = new Set<string>([...added.map(([path]) => path), ...removed.map(([path]) => path)]);
    for (const path of [...this.deferredUnsaved]) if (!active.has(path)) this.deferredUnsaved.delete(path);
    const moves = this.pairMoves(looked, added, removed);
    const inMove = new Set(moves.flatMap((move) => [move.from, move.to]));
    const deletes = removed.filter(([path]) => !inMove.has(path));
    const deleteTops = new Set(deletes.filter(([path]) => looked.files.has(path)).map(([path]) => topSegmentKey(path)));
    const deferredCaseAdds: Array<[string, string]> = [];
    this.notePendingRenames(looked, added, removed, inMove);
    this.noteCues(looked, added);
    this.texts = await this.fetchTexts(looked, added, inMove);
    for (const move of moves) if (this.ready(move.from, move.sha)) await this.guarded(move.from, move.sha, () => this.move(move, said));
    for (const [path, sha] of added) {
      if (inMove.has(path) || !this.ready(path, sha)) continue;
      if (!looked.files.has(path) && this.caseIndex.collision(path) !== null && deleteTops.has(topSegmentKey(path))) {
        deferredCaseAdds.push([path, sha]);
        continue;
      }
      await this.guarded(path, sha, () => this.add(looked, path, sha, said));
    }
    const here = deletes.filter(([path]) => looked.files.has(path) && !this.isPaused(path)).map(([path]) => path);
    const still = new Set(here);
    for (const path of this.releasedDeletes) if (!still.has(path)) this.releasedDeletes.delete(path);
    const asked = here.filter((path) => !this.releasedDeletes.has(path));
    const holdDeletes = asked.length > BURST_FILES;
    if (holdDeletes && this.announcedDeletes !== asked.length) {
      this.announcedDeletes = asked.length;
      const release = (): void => {
        for (const path of asked) this.releasedDeletes.add(path);
        this.ctx.ports.heldDeletes?.(null);
        this.ctx.ports.lookAgain();
      };
      const words = heldDeletesWords(asked.length);
      if (this.ctx.ports.aware()) {
        this.ctx.ports.heldDeletes?.({ count: asked.length, move: release });
        this.ctx.ports.notify(words, { label: "Show them", run: () => this.ctx.ports.openStatus?.() }, { lasting: true });
      } else this.ctx.ports.notify(words, { label: "Move them to the trash", run: release });
    }
    if (!holdDeletes) {
      if (this.announcedDeletes !== 0) this.ctx.ports.heldDeletes?.(null);
      this.announcedDeletes = 0;
    }
    this.gone = await this.confirmGone(looked, deletes, holdDeletes);
    for (const [path, sha] of deletes) {
      if (holdDeletes && looked.files.has(path) && !this.releasedDeletes.has(path)) continue;
      if (this.ready(path, sha)) await this.guarded(path, sha, () => this.remove(looked, path, sha, said));
    }
    for (const [path, sha] of deferredCaseAdds) {
      if (!this.ctx.current()) break;
      if (this.isPaused(path)) continue;
      if (this.caseIndex.collision(path) === null) {
        if (this.ready(path, sha)) await this.guarded(path, sha, () => this.add(looked, path, sha, said));
      } else if (!this.cut && !holdDeletes && !deletes.some(([gone]) => looked.files.has(gone) && topSegmentKey(gone) === topSegmentKey(path) && state.data.seen?.[gone] !== undefined)) {
        this.holdCaseCollision(path, sha);
      }
    }
    this.tellStuck();
    state.save();
    if (!silent) this.tell(said);
    return { changed: said.updated.length + said.merged.length + said.created.length + said.moved.length + said.trashed.length, rescan: this.rescan, more: this.cut, wake: this.wake.value() };
  }

  async bringIn(looked: Looked, path: string): Promise<boolean> {
    const sha = looked.repo.get(path);
    const entry = looked.files.get(path);
    if (sha === undefined || !entry || entry.sha === sha || !this.isUnchanged(path, entry)) return false;
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.reads = 0;
    this.waiting.delete(path);
    const said: Said = { updated: [], merged: [], created: [], moved: [], trashed: [], came: [] };
    await this.guarded(path, sha, () => this.add(looked, path, sha, said, true));
    this.ctx.state.save();
    return said.updated.length > 0;
  }

  private async fetchTexts(looked: Looked, added: Array<[string, string]>, inMove: ReadonlySet<string>): Promise<Map<string, string>> {
    const { ports } = this.ctx;
    if (!ports.blobTexts) return new Map();
    const asked: Array<{ doc: DocumentRef; sha: string }> = [];
    const seen = new Set<string>();
    for (const [path, sha] of added) {
      const doc = ports.documentFor(path);
      const entry = looked.files.get(path);
      const unchanged = entry !== undefined && (entry.sha === this.ctx.state.data.seen?.[path] || this.isUnchanged(path, entry));
      if (!doc || ports.disconnected(doc) || inMove.has(path) || seen.has(sha) || entry?.sha === sha || (!entry && this.caseIndex.collision(path) !== null) || (entry && ((!unchanged && this.isOwnBlob(path, entry, sha)) || this.followsDraft(looked, path, doc, entry))) || !this.ready(path, sha, false)) continue;
      seen.add(sha);
      asked.push({ doc, sha });
      if (asked.length >= TEXTS_PER_PASS) break;
    }
    if (asked.length === 0) return new Map();
    this.reads++;
    return ports.blobTexts(asked);
  }

  textOf(sha: string): string | undefined {
    return this.texts.get(sha);
  }

  private async confirmGone(looked: Looked, deletes: Array<[string, string]>, hold: boolean): Promise<Map<string, boolean> | null> {
    const { ports } = this.ctx;
    if (!ports.confirmGone) return null;
    const asked: DocumentRef[] = [];
    for (const [path, sha] of deletes) {
      const entry = looked.files.get(path);
      const doc = ports.documentFor(path);
      if (!entry || !doc || ports.disconnected(doc) || looked.repo.has(path) || (hold && !this.releasedDeletes.has(path)) || (entry.sha !== sha && !this.isUnchanged(path, entry)) || !this.ready(path, sha, false)) continue;
      asked.push(doc);
    }
    if (asked.length === 0) return new Map();
    this.reads++;
    return ports.confirmGone(asked);
  }

  private async guarded(path: string, sha: string, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch {
      this.ctx.activity.notWritten(path);
      this.ctx.ports.diagnose("a change from main could not be made");
      this.wait(path, sha);
    }
  }

  private ready(path: string, sha: string, spend = true): boolean {
    if (!this.ctx.current()) return false;
    if (this.holds.isCaseHeld(path, sha)) return false;
    if (this.waiting.waiting(path, sha, this.wake)) return false;
    if (this.declined.get(path) === sha || this.announced.get(path) === sha || this.deciding.has(path)) return false;
    if (spend && this.reads >= READS_PER_PASS) {
      this.cut = true;
      return false;
    }
    return true;
  }

  private wait(path: string, sha: string): void {
    this.waiting.defer(path, sha, this.wake);
  }

  private settled(path: string, sha: string | null): void {
    this.clearPending(path);
    const guessed = this.ctx.state.data.guessed;
    if (guessed.includes(path)) this.ctx.state.data.guessed = guessed.filter((one) => one !== path);
    const seen = this.ctx.state.data.seen;
    if (!seen || !this.ctx.current()) return;
    if (sha === null) delete seen[path];
    else seen[path] = sha;
    this.ctx.onSettled?.(path, sha);
  }

  private tell(said: Said): void {
    const parts: string[] = [];
    const list = (names: string[], verb: string): void => {
      if (names.length) parts.push(`${verb} ${names.length === 1 ? names[0]! : `${names.length} notes`}`);
    };
    list(said.updated, "Updated");
    list(said.merged, "Merged GitHub's changes into");
    list(said.created, "Added");
    list(said.moved, "Renamed");
    const matched = parts.length ? [`${parts.join(". ")}, to match GitHub.`] : [];
    const trashed = said.trashed.length ? [trashedWords(said.trashed)] : [];
    if (matched.length + trashed.length === 0) return;
    const message = [...matched, ...trashed].join(" ");
    const { ports } = this.ctx;
    if (ports.seeChanges && said.came.length) ports.notify(message, { label: "See changes", run: () => ports.seeChanges?.(said.came.flatMap(({ name, shown }) => (said.came.length > 1 ? [{ kind: "heading" as const, text: name }, ...shown] : shown))) });
    else ports.notify(message);
  }

  private noteCues(looked: Looked, added: Array<[string, string]>): void {
    const seen = this.ctx.state.data.seen!;
    const now = this.ctx.ports.now();
    const here = new Set<string>();
    for (const [path, sha] of added) {
      if (this.isPaused(path)) continue;
      const entry = looked.files.get(path);
      if (!entry || entry.sha === sha || entry.sha === seen[path] || this.isUnchanged(path, entry)) continue;
      here.add(path);
      if (this.cues.get(path)?.sha !== sha) this.cues.set(path, { sha, since: now, told: false });
    }
    for (const path of [...this.cues.keys()]) if (!here.has(path)) this.cues.delete(path);
    for (const path of [...this.choices]) if (!here.has(path)) this.dropChoice(path);
  }

  private readonly choices = new Set<string>();

  private askChoice(path: string, words: string, label: string, run: () => void, notice: string, plain: string = notice): void {
    if (!this.ctx.ports.aware()) {
      this.ctx.ports.notify(plain, { label, run }, { lasting: true });
      return;
    }
    this.choices.add(path);
    this.ctx.ports.choice?.(path, { words, label, run });
    this.ctx.ports.notify(notice, { label: CHOICE_WORDS.show, run: () => this.ctx.ports.openStatus?.() }, { lasting: true });
  }

  private dropChoice(path: string): void {
    if (this.choices.delete(path)) this.ctx.ports.choice?.(path, null);
  }

  private tellStuck(): void {
    const now = this.ctx.ports.now();
    for (const [path, cue] of this.cues) {
      if (cue.told || now - cue.since < STUCK_MS || this.declined.get(path) === cue.sha || this.announced.get(path) === cue.sha || this.reviewTold.get(path) === cue.sha || this.deciding.has(path)) continue;
      cue.told = true;
      this.askChoice(path, CHOICE_WORDS.main, CHOICE_WORDS.choose, () => this.settleNow(path, cue.sha), `${noteName(path)} changed on GitHub, and you changed it here too. Stay connected hasn't been able to merge the two yet.`);
    }
  }

  private settleNow(path: string, sha: string): void {
    if (!this.ctx.current()) return;
    const looked = this.looked;
    if (!looked) {
      this.ctx.ports.notify(CHOOSE_UNREADABLE);
      this.ctx.ports.lookAgain();
      return;
    }
    this.waiting.delete(path);
    this.declined.delete(path);
    this.announced.delete(path);
    this.settleReason.delete(path);
    this.opening.add(path);
    void (async () => {
      const said: Said = { updated: [], merged: [], created: [], moved: [], trashed: [], came: [] };
      this.reads = 0;
      await this.guarded(path, sha, () => this.add(looked, path, sha, said));
      this.tell(said);
      this.ctx.state.save();
      this.ctx.ports.lookAgain();
      const why = this.settleReason.get(path);
      this.settleReason.delete(path);
      const didWrite = said.updated.length + said.merged.length + said.created.length + said.moved.length + said.trashed.length > 0;
      if (why === "blocked") this.ctx.ports.notify(CHOOSE_BLOCKED);
      else if (why === "matched") this.ctx.ports.notify(CHOOSE_MATCHED);
      else if (why !== "review") {
        if (this.ctx.state.data.seen?.[path] !== sha && !this.deciding.has(path) && !this.declined.has(path)) {
          this.ctx.ports.notify(`specgit couldn't merge ${noteName(path)} with the changes on GitHub just now. It stays in the Status tab, where you can catch it up.`);
        } else if (!didWrite && !this.deciding.has(path) && !this.declined.has(path)) {
          this.ctx.ports.notify(CHOOSE_MATCHED);
        }
      }
      this.opening.delete(path);
    })();
  }

  private notePendingRenames(looked: Looked, added: Array<[string, string]>, removed: Array<[string, string]>, inMove: ReadonlySet<string>): void {
    const seen = this.ctx.state.data.seen!;
    for (const path of [...this.pendingRenames.keys()]) if (looked.repo.has(path)) this.pendingRenames.delete(path);
    const removedBySha = new Map<string, string[]>();
    for (const [from, sha] of removed) {
      if (inMove.has(from) || sha === "" || sha === EMPTY_BLOB) continue;
      const entry = looked.files.get(from);
      if (!entry || entry.sha === sha || this.isUnchanged(from, entry)) continue;
      removedBySha.set(sha, [...(removedBySha.get(sha) ?? []), from]);
    }
    const addedBySha = new Map<string, string[]>();
    for (const [path, sha] of added) {
      if (inMove.has(path) || seen[path] !== undefined || sha === "" || sha === EMPTY_BLOB) continue;
      addedBySha.set(sha, [...(addedBySha.get(sha) ?? []), path]);
    }
    for (const [sha, froms] of removedBySha) {
      if (froms.length !== 1) continue;
      const tos = addedBySha.get(sha);
      if (!tos || tos.length !== 1) continue;
      this.pendingRenames.set(froms[0]!, { to: tos[0]!, sha });
    }
  }

  private pairMoves(looked: Looked, added: Array<[string, string]>, removed: Array<[string, string]>): Array<{ from: string; to: string; sha: string; held: string }> {
    const taken = new Set<string>();
    const moves: Array<{ from: string; to: string; sha: string; held: string }> = [];
    const seen = this.ctx.state.data.seen!;
    for (const [from, sha] of removed) {
      const to = added.find(([path, other]) => other === sha && seen[path] === undefined && !taken.has(path) && !looked.files.has(path));
      const entry = looked.files.get(from);
      if (!to || !entry || (entry.sha !== sha && !this.isUnchanged(from, entry))) continue;
      taken.add(to[0]);
      moves.push({ from, to: to[0], sha, held: entry.sha });
    }
    return moves;
  }

  private async free(path: string, doc: DocumentRef, sha: string): Promise<boolean> {
    const { ports } = this.ctx;
    const why = await notWritableBecause({ phaseOf: (one) => ports.phaseOf(one), hasUnsavedText: (one) => ports.vault.hasUnsavedText(one) }, path);
    if (why !== null) {
      if (this.opening.has(path)) this.settleReason.set(path, "blocked");
      if (why === "typing") this.deferredUnsaved.add(path);
      return this.notFree(path, sha);
    }
    this.deferredUnsaved.delete(path);
    const drafts = this.looked?.drafts;
    const review = drafts?.level && !ports.inGroup(path) ? (drafts.byPath.has(path) ? "open" : "none") : await this.readReview(doc);
    if (review === "none") return true;
    if (review === "open") {
      if (this.opening.has(path)) {
        this.settleReason.set(path, "review");
        this.ctx.ports.settleReview(path);
        return false;
      }
      this.tellReview(path, sha);
    }
    return this.notFree(path, sha);
  }

  private async readReview(doc: DocumentRef): ReturnType<StayPorts["reviewOf"]> {
    this.reads++;
    return this.ctx.ports.reviewOf(doc);
  }

  private tellReview(path: string, sha: string): void {
    const entry = this.looked?.files.get(path);
    const seen = this.ctx.state.data.seen?.[path];
    if (!entry || entry.sha === sha || entry.sha === seen || this.isUnchanged(path, entry) || this.reviewTold.get(path) === sha) return;
    this.reviewTold.set(path, sha);
    this.askChoice(path, CHOICE_WORDS.review, CHOICE_WORDS.catchUp, () => this.ctx.ports.settleReview(path), `${noteName(path)} is in review and was also changed on GitHub. Catch up adds the GitHub changes, and asks only about places you both changed.`, `${noteName(path)} changed on GitHub while in review. Click Catch up to bring the changes in.`);
  }

  private unwritten(path: string, sha: string, ...also: string[]): void {
    this.ctx.activity.notWritten(path, ...also);
    this.wait(path, sha);
  }

  private async refusedWrite(path: string, sha: string, written: "written" | "refused" | "gone"): Promise<void> {
    if (written === "refused" && (await this.ctx.ports.vault.hasUnsavedText(path))) this.deferredUnsaved.add(path);
    this.unwritten(path, sha);
  }

  private keepAsBase(path: string, doc: DocumentRef, main: MainText): void {
    if (!this.ctx.current()) return;
    this.ctx.ports.recordBase(path, doc, toLf(main.text), main.text);
    this.ctx.ports.rebase(path, main.sha);
  }

  private notFree(path: string, sha: string): false {
    this.wait(path, sha);
    return false;
  }

  private isOwnBlob(path: string, entry: CacheEntry, sha: string): boolean {
    const endedOwn = this.ctx.state.data.endedOwn;
    return entry.sent === sha || endedOwn?.[path]?.sent === sha || agreedOf(entry) === sha || this.ctx.isOwnBlob?.(path, sha) === true;
  }

  private settleOwnSent(looked: Looked, path: string, entry: CacheEntry, sha: string): void {
    delete this.ctx.state.data.endedOwn?.[path];
    const draft = looked.drafts?.byPath.get(path);
    if (looked.drafts?.level === true && !draft && entry.sent === sha) {
      this.ctx.ports.agreed(path, null);
      clearSent(entry);
      this.rescan = true;
    } else if (entry.sent === sha) {
      this.ctx.onRebasedSent?.(path, sha);
    }
  }

  private rebaseOwn(looked: Looked, path: string, doc: DocumentRef, entry: CacheEntry, sha: string): void {
    if (!this.isOwnBlob(path, entry, sha)) return;
    if (entry.base !== sha) {
      const known = this.texts.get(sha);
      if (known !== undefined) this.ctx.ports.recordBase(path, doc, toLf(known), known);
      this.ctx.ports.rebase(path, sha);
      entry.base = sha;
      this.rescan = true;
    }
    this.settleOwnSent(looked, path, entry, sha);
    this.ctx.onResolved?.(path);
  }

  private async add(looked: Looked, path: string, sha: string, said: Said, explicit = false): Promise<void> {
    const { ports } = this.ctx;
    const doc = ports.documentFor(path);
    if (!doc) return this.settled(path, sha);
    if (!explicit && ports.disconnected(doc)) {
      if (this.opening.has(path)) this.settleReason.set(path, "blocked");
      return;
    }
    const entry = looked.files.get(path);
    if (entry !== undefined && (entry.sha === sha || entry.base === sha || (entry.same === sha && entry.sameBy !== "server"))) {
      if (this.opening.has(path)) this.settleReason.set(path, "matched");
      if (entry.base !== sha) {
        const known = this.texts.get(sha);
        if (known !== undefined) ports.recordBase(path, doc, toLf(known), known);
        ports.rebase(path, sha);
        entry.base = sha;
      }
      this.settleOwnSent(looked, path, entry, sha);
      if (entry.base === sha) this.ctx.onResolved?.(path);
      return this.settled(path, sha);
    }
    if (!entry && looked.deleted.some((gone) => gone.path === path)) return this.settled(path, sha);
    if (!entry && this.caseIndex.collision(path) !== null) return this.holdCaseCollision(path, sha);
    const seenBefore = this.ctx.state.data.seen?.[path] ?? null;
    const diskUnchanged = entry !== undefined && (entry.sha === seenBefore || this.isUnchanged(path, entry));
    if (entry && !diskUnchanged && this.isOwnBlob(path, entry, sha)) {
      this.rebaseOwn(looked, path, doc, entry, sha);
      return this.settled(path, sha);
    }
    if (entry && this.followsDraft(looked, path, doc, entry)) {
      return this.settled(path, sha);
    }
    if (!(await this.free(path, doc, sha))) return;
    const batched = this.texts.get(sha);
    const main: MainFile = batched !== undefined ? { kind: "file", text: batched, sha } : await this.readMain(doc);
    if (main.kind !== "file" || !this.ctx.current()) return this.wait(path, sha);
    if (entry?.sha === main.sha) {
      if (this.opening.has(path)) this.settleReason.set(path, "matched");
      if (entry.base !== main.sha) {
        this.keepAsBase(path, doc, main);
        entry.base = main.sha;
        this.rescan = true;
      }
      this.settleOwnSent(looked, path, entry, main.sha);
      return this.settled(path, main.sha);
    }
    if (!entry) return this.create(path, doc, main, said);
    const before = this.ctx.state.data.seen?.[path] ?? null;
    const unchanged = entry.sha === before || this.isUnchanged(path, entry);
    return unchanged ? this.update(path, doc, entry.sha, main, said) : this.merge(path, doc, entry, before, main, said);
  }

  private followsDraft(looked: Looked, path: string, doc: DocumentRef, entry: Pick<CacheEntry, "sent" | "sentTo">): boolean {
    const { ports } = this.ctx;
    const draft = looked.drafts?.byPath.get(path);
    if (!draft || ports.phaseOf(path) !== "local" || ports.disconnected(doc) || ports.inGroup(path)) return false;
    return follows(draft, ports.login(), entry, ports.policy());
  }

  private async readMain(doc: DocumentRef): Promise<MainFile> {
    this.reads++;
    return this.ctx.ports.gitFile(doc);
  }

  private async create(path: string, doc: DocumentRef, main: MainText, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    activity.ownWrite(path);
    const made = await ports.vault.create(path, main.text);
    if (made === "exists" && !ports.vault.exists(path)) {
      activity.notWritten(path);
      return this.holdCaseCollision(path, main.sha);
    }
    if (made !== "created") return this.unwritten(path, main.sha);
    this.caseIndex.add(path);
    await this.bring(path, main.text);
    this.keepAsBase(path, doc, main);
    this.settled(path, main.sha);
    said.created.push(noteName(path));
    this.came(said, path, "", main.text);
  }

  private async bring(path: string, text: string): Promise<void> {
    try {
      await this.ctx.ports.bringFor?.(path, text);
    } catch {
      this.ctx.ports.diagnose("the files of main's words could not be brought in");
    }
  }

  private came(said: Said, path: string, before: string, after: string): void {
    const shown = changesBetween(toLf(before), toLf(after));
    if (shown) said.came.push({ name: noteName(path), shown });
  }

  private async update(path: string, doc: DocumentRef, expected: string, main: MainText, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    activity.ownWrite(path);
    let before = "";
    let after = main.text;
    const written = await ports.vault.process(path, (current) => {
      before = current;
      if (gitBlobShaOfText(current) !== expected) return null;
      after = withBomAndEol(toLf(main.text), current);
      return after;
    });
    if (written !== "written") return this.refusedWrite(path, main.sha, written);
    await this.bring(path, after);
    this.came(said, path, before, after);
    this.keepAsBase(path, doc, main);
    delete this.ctx.state.data.endedOwn?.[path];
    this.settled(path, main.sha);
    said.updated.push(noteName(path));
  }

  private async merge(path: string, doc: DocumentRef, entry: CacheEntry, before: string | null, main: MainText, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    const mine = await ports.vault.read(path);
    if (mine === null) return this.wait(path, main.sha);
    const endedOwn = this.ctx.state.data.endedOwn;
    const sentMatchesMain = (entry.sent ?? endedOwn?.[path]?.sent) === main.sha;
    const matched = entry.base ?? (this.ctx.state.data.guessed.includes(path) ? null : before);
    const base = sentMatchesMain
      ? toLf(main.text)
      : await matchedBase(
          matched,
          (sha) => {
            this.reads++;
            return ports.blobText(doc, sha);
          },
          () => ports.baseText(path, matched),
        );
    const result = mergeFile(path, base === null ? null : stripBom(base), stripBom(toLf(mine)), stripBom(toLf(main.text)), new Budget(400));
    if (result.kind === "conflict") return this.askPerson(path, doc, main, mine, result.review);
    const merged = withBomAndEol(result.text, mine);
    if (merged !== mine) {
      activity.ownWrite(path);
      const written = await ports.vault.process(path, (current) => (current === mine ? merged : null));
      if (written !== "written") return this.refusedWrite(path, main.sha, written);
      await this.bring(path, merged);
      said.merged.push(noteName(path));
      this.came(said, path, mine, merged);
    } else this.rescan = true;
    this.keepAsBase(path, doc, main);
    delete endedOwn?.[path];
    if (sentMatchesMain) {
      ports.agreed(path, null);
      clearSent(entry);
    }
    this.settled(path, main.sha);
  }

  private askPerson(path: string, doc: DocumentRef, main: MainText, mine: string, review: ReviewPayload): void {
    if (this.declined.get(path) === main.sha || this.deciding.has(path)) return;
    if (!this.opening.has(path)) {
      if (this.announced.get(path) === main.sha) return;
      this.announced.set(path, main.sha);
      const cue = this.cues.get(path);
      if (cue) cue.told = true;
      this.askChoice(path, CHOICE_WORDS.main, CHOICE_WORDS.choose, () => this.settleNow(path, main.sha), `${noteName(path)} was changed here and on GitHub, in the same place. Nothing was overwritten.`);
      return;
    }
    this.opening.delete(path);
    this.deciding.add(path);
    const { ports, activity } = this.ctx;
    this.queue = this.queue.then(async () => {
      try {
        if (!this.ctx.current() || this.abort.signal.aborted) return;
        const chosen = await ports.chooseWhatToKeep(buildReviewRequest(path, review, { other: "github", signal: this.abort.signal }));
        if (chosen === null) return void this.declined.set(path, main.sha);
        if (!this.ctx.current()) return;
        const text = withBomAndEol(chosen, mine);
        activity.ownWrite(path);
        if ((await ports.vault.process(path, (current) => (current === mine ? text : null), { confirmed: true })) !== "written") {
          ports.notify(DRAFT_SAID.notApplied(noteName(path)));
          return this.unwritten(path, main.sha);
        }
        await this.bring(path, text);
        this.keepAsBase(path, doc, main);
        delete this.ctx.state.data.endedOwn?.[path];
        this.settled(path, main.sha);
        this.ctx.onResolved?.(path);
        this.ctx.state.save();
        ports.lookAgain();
      } catch {
        this.wait(path, main.sha);
      } finally {
        this.deciding.delete(path);
      }
    });
  }

  private async move(move: { from: string; to: string; sha: string; held: string }, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    const [from, to] = [ports.documentFor(move.from), ports.documentFor(move.to)];
    if (!from || !to) return this.settled(move.from, null);
    if (ports.disconnected(from) || ports.disconnected(to)) return;
    if (this.caseIndex.collision(move.to, move.from) !== null) return this.holdCaseCollision(move.to, move.sha, move.from);
    if (ports.phaseOf(move.to) !== "local" || !(await this.free(move.from, from, move.sha))) return this.wait(move.from, move.sha);
    const mirror = this.looked?.repo;
    if (!mirror || mirror.has(move.from) || mirror.get(move.to) !== move.sha || !this.ctx.current()) return this.wait(move.from, move.sha);
    const current = await ports.vault.read(move.from);
    if (current === null || gitBlobShaOfText(current) !== move.held || ports.vault.exists(move.to)) return this.wait(move.from, move.sha);
    activity.ownWrite(move.from, move.to);
    const moved = await ports.vault.rename(move.from, move.to);
    if (moved === "exists" && !ports.vault.exists(move.to)) {
      activity.notWritten(move.from, move.to);
      return this.holdCaseCollision(move.to, move.sha, move.from);
    }
    if (moved !== "renamed") return this.unwritten(move.from, move.sha, move.to);
    this.caseIndex.removeFile(move.from, (dir) => ports.vault.exists(dir));
    this.caseIndex.add(move.to);
    if (move.from !== move.to) ports.forgetDelete(move.from);
    this.settled(move.from, null);
    this.settled(move.to, move.sha);
    said.moved.push(noteName(move.to));
  }

  private async remove(looked: Looked, path: string, sha: string, said: Said): Promise<void> {
    const { ports, state, activity } = this.ctx;
    const entry = looked.files.get(path);
    const doc = ports.documentFor(path);
    if (!entry) {
      if (doc && !looked.repo.has(path) && looked.deleted.some((gone) => gone.path === path)) ports.forgetDelete(path);
      return this.settled(path, null);
    }
    if (!doc) return this.settled(path, null);
    if (ports.disconnected(doc)) return;
    if (entry.sha !== sha && !this.isUnchanged(path, entry)) {
      if (!state.data.kept.includes(path)) state.data.kept.push(path);
      const moved = this.pendingRenames.get(path);
      if (moved !== undefined && moved.sha === sha && state.noteRenameTold(path, moved.to, sha, ports.now())) {
        ports.notify(DRAFT_SAID.renameKept(noteName(path), noteName(moved.to)));
      }
      return this.settled(path, null);
    }
    if (!(await this.free(path, doc, sha))) return;
    const mirror = looked.repo.get(path);
    if (mirror !== undefined) return this.settled(path, mirror);
    if (this.gone !== null) {
      const there = this.gone.get(path);
      if (there !== false || !this.ctx.current()) return this.wait(path, sha);
    } else {
      this.reads++;
      const main = await ports.gitFile(doc);
      if (main.kind === "file") return this.settled(path, main.sha);
      if (main.kind !== "absent" || !this.ctx.current()) return this.wait(path, sha);
    }
    activity.ownWrite(path);
    if (!(await ports.vault.trash(path, entry.sha))) return this.unwritten(path, sha);
    this.caseIndex.removeFile(path, (dir) => ports.vault.exists(dir));
    ports.forgetDelete(path);
    this.settled(path, null);
    said.trashed.push(noteName(path));
  }
}
