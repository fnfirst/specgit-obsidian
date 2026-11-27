import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf, clearSent, type CacheEntry } from "../changes/cache";
import type { Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { Budget } from "../disk/diff";
import { stripBom, toLf } from "../disk/line-endings";
import { buildReviewRequest, mergeFile } from "../disk/structured-merge";
import { CasePathIndex, type DocumentRef, noteName } from "../mapping";
import type { Activity } from "./activity";
import { type Case, draftCase, type Draft, draftKey, draftWriter, type Ended, type FileFacts, follows, isClean, type LeftAlone, type StayDrafts } from "./draft-state";
import type { BranchFile, MainFile } from "../auth/git-copy";
import { DraftDeletes } from "./draft-deletes";
import { TeammateOffers } from "./draft-offers";
import { DraftRenames, RENAME_HOLD_MS } from "./draft-renames";
import type { End } from "./ends";
import { caseCollisionWords, StayHolds, vaultCaseIndex } from "./holds";
import { FIRST_WAIT_MS, MAX_WAIT_MS, READS_PER_PASS, TEXTS_PER_PASS as MAIN_TEXTS_PER_PASS } from "./inbound";
import { changeKey } from "./outbound";
import { admitDraftReads, backfillAgreed, computeBusyBeforeDraftRun, endedMemoOf, excludeRenameLooked, fallbackHeardDraft, fileFactsOf, finalizeDraftBusy, isFreshLocalUntitled, isSkippableDraftMerge, matchesDraftBlobOnDisk, prioritizeDraftPaths, readDraftMergeBase, snapshotDraftBusy, stepBackoff, writeDraftText, yieldQuiet } from "./outbound-pass";
import type { StayState } from "./state";
import type { StayPorts } from "./types";
import { BackoffWaits, WakeClock } from "./wait";
import { CHOICE_WORDS, DRAFT_SAID } from "./words";

export const TEXTS_PER_PASS = 25;
export const DRAFTS_PER_PASS = 25;
export const RECENT_MS = 5_000;
export const ENDED_AFTER_MS = 60_000;
export const UNLEVEL_ENDED_WAITS_MS = [10_000, 20_000, 40_000, 80_000, 120_000] as const;
export const UNSAVED_WAITS_MS = [5_000, 10_000, 20_000, 40_000] as const;

export const TRANSIT_MS = 2_000;

const CHOOSE_MATCHED = "This note already matches GitHub. Nothing to resolve.";
const CHOOSE_BLOCKED = "Save or disconnect this note first, then try Choose what to keep again.";
const CHOOSE_UNREADABLE = "specgit couldn't read GitHub's version just now. Try again in a moment.";

export { RENAME_HOLD_MS };

export interface DraftContext {
  ports: StayPorts;
  state: StayState;
  activity: Activity;
  holds?: StayHolds;
  isRemoteRoom?(path: string, sha: string): boolean;
  isRemoteRoomBlob?(path: string, diskSha: string, draftBlob: string): boolean;
  noteOwnBlob?(path: string, sha: string): void;
  clearOwnBlobs?(path: string): void;
  renameOwnBlobs?(from: string, to: string): void;
  consumeRebasedSent?(path: string, sha: string): boolean;
  hasConflict?(path: string, looked: Looked): boolean;
  onResolved?(path: string): void;
  sentSinceLook?: () => Iterable<string>;
  quietWaitMs?: () => number;
  current(): boolean;
}

export interface DraftPass {
  changed: number;
  rescan: boolean;
  more: boolean;
  wake: number | null;
  heldFrom: ReadonlySet<string>;
  busyPaths: ReadonlySet<string>;
}

export class DraftInbound {
  private reads = 0;
  private draftOps = 0;
  private cut = false;
  private progressed = false;
  private rescan = false;
  private readonly wake = new WakeClock();
  private readonly unlevel = new Map<string, { strikes: number; until: number }>();
  private readonly unsaved = new Map<string, { strikes: number; until: number }>();
  private readonly deferredUnsaved = new Set<string>();
  private deferredRenameSources: ReadonlySet<string> = new Set();
  private looked: Looked | null = null;
  private caseIndex = new CasePathIndex();
  private readonly waiting: BackoffWaits;
  private readonly endWaiting: BackoffWaits;
  private readonly holds: StayHolds;
  private readonly toldConflict = new Map<string, string>();
  private readonly cleanMerges = new Map<string, string>();
  private readonly noticed = new Set<string>();
  private readonly offers: TeammateOffers;
  private readonly attachmentsFor = new Map<string, { blob: string; replaced: boolean }>();
  private readonly attachmentWaits = new Map<string, { strikes: number; until: number }>();
  private readonly endedMemo: ReturnType<typeof endedMemoOf>;
  private readyToSend = new Set<string>();
  pending(path: string): boolean {
    return this.endedMemo.has(path);
  }
  holdingRenameSource(path: string): boolean {
    return this.deferredRenameSources.has(path);
  }
  private ends = new Map<string, End | "unknown">();
  private endsAsked = new Set<string>();
  private endsRetryAfterMs: number | undefined = undefined;
  private texts = new Map<string, string>();
  private draftTexts = new Map<string, string>();
  private draftsDeferred = new Set<string>();
  private known: (sha: string) => string | undefined = () => undefined;
  private readonly awaiting = new Map<string, { sent: string; to: string | null; agreed: string }>();
  private readonly crlfMiss = new Map<string, string>();
  private readonly deciding = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();

  private readonly renames: DraftRenames;
  private readonly deletes: DraftDeletes;

  constructor(private readonly ctx: DraftContext) {
    this.endedMemo = endedMemoOf(ctx.state);
    this.holds = ctx.holds ?? new StayHolds(ctx.state, ctx.activity, ctx.ports);
    this.offers = new TeammateOffers({ ports: ctx.ports, state: ctx.state, settleNow: (path) => this.settleNow(path) });
    const delayFor = (strikes: number): number => Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** strikes);
    this.waiting = new BackoffWaits(() => this.ctx.ports.now(), delayFor);
    this.endWaiting = new BackoffWaits(() => this.ctx.ports.now(), delayFor);
    this.renames = new DraftRenames(ctx, {
      ready: (path, spend, pairing) => this.ready(path, spend, pairing),
      wait: (path) => this.wait(path),
      settled: (path) => this.settled(path),
      leftAlone: (looked, path, options) => this.leftAlone(looked, path, options),
      deferUnsaved: (path) => this.deferUnsaved(path),
      reads: () => this.reads,
      spendRead: () => {
        this.reads++;
        this.progressed = true;
      },
      cutPass: () => void (this.cut = true),
      caseCollision: (to, from) => this.caseIndex.collision(to, from) !== null,
      holdCaseCollision: (path, key) => this.holdCaseCollision(path, key),
      holdRenamedKept: (looked, path) => this.holds.holdRenamedKept(looked, path),
      forgetEnded: (path) => this.endedMemo.delete(path),
      noteRenamed: (from, to) => {
        this.caseIndex.removeFile(from, (dir) => this.ctx.ports.vault.exists(dir));
        this.caseIndex.add(to);
      },
      noteRemoved: (path) => this.caseIndex.removeFile(path, (dir) => this.ctx.ports.vault.exists(dir)),
      awaiting: this.awaiting,
    });
    this.deletes = new DraftDeletes(ctx, {
      wait: (path) => this.wait(path),
      settled: (path) => this.settled(path),
      forgetEnded: (path) => this.endedMemo.delete(path),
      holdDeleted: (looked, path, deletedAt) => this.holds.holdDeleted(looked, path, deletedAt),
      noteRemoved: (path) => this.caseIndex.removeFile(path, (dir) => this.ctx.ports.vault.exists(dir)),
    });
  }

  private holdCaseCollision(path: string, key: string): void {
    this.progressed = true;
    if (this.holds.holdCaseCollision(path, key)) this.ctx.ports.notify(caseCollisionWords(noteName(path)));
    this.settled(path);
  }

  stop(): void {
    this.abort.abort();
    this.offers.stop();
    for (const path of [...this.noticed]) this.clearConflict(path);
    this.toldConflict.clear();
    this.cleanMerges.clear();
    this.attachmentsFor.clear();
    this.attachmentWaits.clear();
    this.unsaved.clear();
    this.deferredUnsaved.clear();
    this.crlfMiss.clear();
    this.deferredRenameSources = new Set();
  }

  private conflictTag(path: string, blob: string | null): string {
    if (blob !== null && blob !== "") return blob;
    return `branch|${this.looked?.drafts?.byPath.get(path)?.branch ?? path}`;
  }

  tellConflict(path: string, blob: string | null): void {
    const tag = this.conflictTag(path, blob);
    if (this.toldConflict.get(path) === tag) return;
    this.toldConflict.set(path, tag);
    this.progressed = true;
    if (this.noticed.has(path)) return;
    this.noticed.add(path);
    if (!this.ctx.ports.aware()) {
      this.ctx.ports.notify(DRAFT_SAID.conflict(noteName(path)), { label: DRAFT_SAID.chooseButton, run: () => void this.settleNow(path) }, { lasting: true });
      return;
    }
    this.ctx.ports.choice?.(path, { words: CHOICE_WORDS.draft, label: CHOICE_WORDS.choose, run: () => void this.settleNow(path) });
    this.ctx.ports.notify(DRAFT_SAID.conflict(noteName(path)), { label: CHOICE_WORDS.show, run: () => this.ctx.ports.openStatus?.() }, { lasting: true });
  }

  clearConflict(path: string): void {
    this.toldConflict.delete(path);
    if (this.noticed.delete(path)) this.ctx.ports.choice?.(path, null);
  }

  release(path: string): void {
    this.waiting.delete(path);
    this.endWaiting.delete(path);
    this.clearUnsaved(path);
  }

  unsavedPaths(): string[] {
    return [...this.deferredUnsaved];
  }

  private deferUnsaved(path: string): void {
    this.deferredUnsaved.add(path);
    const now = this.ctx.ports.now();
    const until = stepBackoff(this.unsaved, path, now, UNSAVED_WAITS_MS);
    if (until !== null) this.wake.until(until, now);
  }

  private clearUnsaved(path: string): void {
    this.deferredUnsaved.delete(path);
    this.unsaved.delete(path);
  }

  told(path: string, blob: string | null): boolean {
    return this.toldConflict.get(path) === this.conflictTag(path, blob);
  }

  async readOne(looked: Looked, path: string): Promise<{ changed: number; rescan: boolean; wake: number | null }> {
    const draft = looked.drafts?.byPath.get(path);
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.reads = 0;
    this.draftOps = 0;
    this.cut = false;
    this.progressed = false;
    this.rescan = false;
    this.wake.reset();
    const moved = fallbackHeardDraft(looked, path, this.ctx.ports.login());
    if (!looked.drafts && moved === null) return { changed: 0, rescan: false, wake: null };
    if (draft && looked.drafts && !looked.files.has(path) && this.renames.mayBeRename(excludeRenameLooked(looked, this.ctx.sentSinceLook?.() ?? new Set()), looked.drafts.byPath, path, draft) && this.renames.holding(path)) {
      this.ctx.ports.lookAgain();
      return { changed: 0, rescan: false, wake: null };
    }
    this.forgetReads();
    const changed = ((await this.one(looked, path, moved, looked.drafts?.level ?? false)) ? 1 : 0) + (await this.deletes.flush(looked));
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, rescan: this.rescan, wake: this.wake.value() };
  }

  async readEnded(looked: Looked, path: string): Promise<{ changed: number; rescan: boolean; wake: number | null }> {
    this.forgetReads();
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.reads = 0;
    this.draftOps = 0;
    this.cut = false;
    this.progressed = false;
    this.rescan = false;
    this.wake.reset();
    const changed = ((await this.one(looked, path, null, true)) ? 1 : 0) + (await this.deletes.flush(looked));
    this.tellClosed();
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, rescan: this.rescan, wake: this.wake.value() };
  }

  busyBeforeRun(looked: Looked, committed: ReadonlySet<string>): Set<string> {
    const { ports } = this.ctx;
    return computeBusyBeforeDraftRun({ looked, awaiting: this.awaiting.keys(), endedKeys: this.endedMemo.keys(), deferredRenameSources: this.deferredRenameSources, committed, login: ports.login(), now: ports.now(), inGroup: (path) => ports.inGroup(path), policyFor: (path, draft) => this.policyFor(path, draft), isRemoteRoom: (path, sha) => this.isRemoteRoom(path, sha) });
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
    this.endsRetryAfterMs = undefined;
    this.texts = new Map();
    this.draftTexts = new Map();
    this.draftsDeferred = new Set();
  }

  async run(looked: Looked, known: (sha: string) => string | undefined = () => undefined, extraSkip: ReadonlySet<string> = new Set()): Promise<DraftPass> {
    const drafts = looked.drafts;
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.known = known;
    this.reads = 0;
    this.draftOps = 0;
    this.cut = false;
    this.progressed = false;
    this.rescan = false;
    this.wake.reset();
    this.deferredRenameSources = new Set();
    this.readyToSend = new Set();
    const awaitingAtStart = new Set(this.awaiting.keys());
    const busy = snapshotDraftBusy(looked, drafts, awaitingAtStart, this.endedMemo.keys());
    for (const path of extraSkip) busy.add(path);
    if (this.keepAwaiting(looked) > 0) this.rescan = true;
    let changed = 0;
    if (!drafts) {
      return { changed, rescan: this.rescan, more: false, wake: null, heldFrom: this.deferredRenameSources, busyPaths: finalizeDraftBusy(busy, { awaitingAtStart, awaiting: this.awaiting.keys(), endedKeys: this.endedMemo.keys() }) };
    }
    this.holds.pruneCaseCollisions(looked, this.caseIndex);
    this.offers.noteInitial(looked, drafts);
    await backfillAgreed(looked, this.ctx.ports, () => this.ctx.current());
    this.deletes.dropGone(looked);
    const pairLooked = excludeRenameLooked(looked, new Set([...extraSkip, ...(this.ctx.sentSinceLook?.() ?? [])]));
    const pairByPath = extraSkip.size > 0 ? new Map([...drafts.byPath].filter(([path]) => !extraSkip.has(path))) : drafts.byPath;
    this.renames.dropSettled(pairLooked, pairByPath);
    const renamed = await this.renames.pair(pairLooked, pairByPath);
    this.deferredRenameSources = renamed.heldFrom;
    changed += renamed.changed;
    const paths = new Set<string>([...drafts.byPath.keys(), ...this.endedMemo.keys(), ...[...looked.files].filter(([, entry]) => entry.sent !== undefined).map(([path]) => path)]);
    const skip = new Set<string>([...renamed.paths, ...renamed.heldFrom, ...extraSkip]);
    await this.readEnds(looked, paths, drafts, skip);
    await this.readDrafts(looked, paths, drafts, skip);
    for (const path of [...this.unlevel.keys()]) if (!paths.has(path)) this.unlevel.delete(path);
    for (const path of [...this.crlfMiss.keys()]) if (!paths.has(path)) this.crlfMiss.delete(path);
    for (const path of [...this.cleanMerges.keys()]) if (!paths.has(path)) this.cleanMerges.delete(path);
    for (const path of [...this.attachmentWaits.keys()]) if (!paths.has(path)) this.attachmentWaits.delete(path);
    for (const path of [...this.deferredUnsaved]) if (!paths.has(path) && !renamed.heldFrom.has(path)) this.clearUnsaved(path);
    for (const path of [...this.unsaved.keys()]) if (!paths.has(path) && !renamed.heldFrom.has(path)) this.unsaved.delete(path);
    for (const path of prioritizeDraftPaths(paths, this.ctx.ports.activePath?.() ?? null)) {
      if (!this.ctx.current()) break;
      if (skip.has(path)) continue;
      if (await this.one(looked, path, drafts.byPath.get(path) ?? null, drafts.level)) changed++;
    }
    changed += await this.deletes.flush(looked);
    this.offers.tell(drafts);
    this.tellClosed();
    this.deletes.tellKept();
    this.ctx.state.save();
    return {
      changed,
      rescan: this.rescan,
      more: this.cut && (changed > 0 || this.rescan || this.progressed),
      wake: this.wake.value(),
      heldFrom: this.deferredRenameSources,
      busyPaths: finalizeDraftBusy(busy, { awaitingAtStart, renamed: renamed.paths, heldFrom: renamed.heldFrom, awaiting: this.awaiting.keys(), endedKeys: this.endedMemo.keys(), readyToSend: this.readyToSend }),
    };
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

  private isRemoteRoom(path: string, sha: string): boolean {
    return this.ctx.isRemoteRoom?.(path, sha) === true;
  }

  private isRemoteRoomBlob(path: string, diskSha: string, draftBlob: string): boolean {
    return this.ctx.isRemoteRoomBlob?.(path, diskSha, draftBlob) === true;
  }

  private facts(looked: Looked, path: string): FileFacts {
    return fileFactsOf(looked, path, (one, sha) => this.isRemoteRoom(one, sha));
  }

  private async leftAlone(looked: Looked, path: string, options?: { allowLive?: boolean; transientOnly?: boolean; quietWake?: boolean }): Promise<LeftAlone | null> {
    const { ports, activity } = this.ctx;
    if (options?.transientOnly !== true) {
      const doc = ports.documentFor(path);
      if (doc && ports.disconnected(doc)) return "disconnected";
      const phase = ports.phaseOf(path);
      if (phase !== "local" && !(options?.allowLive === true && phase === "live")) return "live";
    }
    if (activity.isSuspect(path) || activity.isGit(path)) return "tool";
    const entry = looked.files.get(path);
    if (entry) {
      const age = ports.now() - entry.mtime;
      if (age < RECENT_MS) {
        if (!options?.quietWake) this.wake.at(RECENT_MS - age);
        return "recent";
      }
    }
    return entry && (await ports.vault.hasUnsavedText(path)) ? "unsaved" : null;
  }

  private async readEnds(looked: Looked, paths: ReadonlySet<string>, drafts: NonNullable<Looked["drafts"]>, skip: ReadonlySet<string>): Promise<void> {
    const { ports } = this.ctx;
    this.ends = new Map();
    this.endsAsked = new Set();
    this.endsRetryAfterMs = undefined;
    this.texts = new Map();
    if (!ports.reviewEnds || !drafts.level) return;
    const asked: Array<{ path: string; doc: DocumentRef; number: number; group: boolean }> = [];
    for (const path of paths) {
      if (skip.has(path)) continue;
      const entry = looked.files.get(path);
      const doc = ports.documentFor(path);
      const number = /^(?:pr|group):(\d+)$/.exec(entry?.sentTo ?? "")?.[1];
      if (!doc || !entry || entry.sent === undefined || number === undefined || drafts.byPath.has(path) || this.endedMemo.has(path) || ports.inGroup(path)) continue;
      if (ports.now() - (entry.sentAt ?? 0) <= ENDED_AFTER_MS) continue;
      const facts = this.facts(looked, path);
      const kind = draftCase({ file: facts, draft: null, login: ports.login(), policy: ports.policy(), leftAlone: null, ended: null }).kind;
      if ((kind === "none" || kind === "wait") && this.ready(path, false)) asked.push({ path, doc, number: Number(number), group: entry.sentTo?.startsWith("group:") === true });
    }
    if (asked.length === 0) return;
    const answer = await ports.reviewEnds(asked.map(({ doc, number, group }) => ({ doc, number, ...(group ? { group: true } : {}) })));
    if (!this.ctx.current() || answer.kind === "unsupported") return;
    this.endsRetryAfterMs = answer.retryAfterMs;
    for (const { path, number } of asked) {
      const end = answer.ends.get(number);
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
      if (wanted.length >= MAIN_TEXTS_PER_PASS) break;
    }
    if (wanted.length > 0) this.texts = await ports.blobTexts(wanted);
  }

  private async readDrafts(looked: Looked, paths: ReadonlySet<string>, drafts: NonNullable<Looked["drafts"]>, skip: ReadonlySet<string>): Promise<void> {
    const { ports } = this.ctx;
    this.draftTexts = new Map();
    this.draftsDeferred = new Set();
    if (!ports.draftTexts || !drafts.level) return;
    const { asked, deferred } = await admitDraftReads({ looked, paths, drafts, skip, ports, transitMs: TRANSIT_MS, draftsPerPass: DRAFTS_PER_PASS, textsPerPass: TEXTS_PER_PASS, cleanMerges: this.cleanMerges, factsOf: (path) => this.facts(looked, path), policyFor: (path, draft) => this.policyFor(path, draft), hasCollision: (path) => this.caseIndex.collision(path) !== null, isHeldMeet: (kind, path, entry) => this.isHeldMeet(kind, path, entry), isReady: (path) => this.ready(path, false), isTold: (path, blob) => this.told(path, blob), isEditHeld: (path, sha) => this.holds.isEditHeld(path, sha), isLeftAlone: (path) => this.leftAlone(looked, path, { quietWake: true }) });
    this.draftsDeferred = deferred;
    if (asked.length > 0 && this.ctx.current()) this.draftTexts = await ports.draftTexts(asked);
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
    if (this.waiting.waiting(path, undefined, this.wake)) return false;
    if (!pairing && this.endWaiting.waiting(path, undefined, this.wake)) return false;
    if (spend && this.reads >= READS_PER_PASS) {
      this.cut = true;
      return false;
    }
    return true;
  }

  private wait(path: string): void {
    this.progressed = true;
    this.waiting.defer(path, undefined, this.wake);
  }

  private waitEnd(path: string, retryAfterMs?: number): void {
    this.progressed = true;
    this.endWaiting.defer(path, undefined, this.wake, retryAfterMs);
  }

  private settled(path: string): void {
    this.waiting.delete(path);
    this.endWaiting.delete(path);
  }

  private isHeldMeet(kind: Case["kind"], path: string, entry: Pick<CacheEntry, "sha" | "base"> | undefined): boolean {
    return kind === "meet" && entry !== undefined && entry.base !== null && this.holds.isEditHeld(path, entry.sha);
  }

  private agreeDraft(path: string, entry: Pick<CacheEntry, "sent" | "base"> | undefined, agreement: { sent: string; to: string | null; agreed?: string }): void {
    this.progressed = true;
    this.cleanMerges.delete(path);
    if (entry?.sent !== undefined && entry.sent !== agreement.sent && entry.base !== entry.sent) {
      this.ctx.noteOwnBlob?.(path, entry.sent);
    }
    this.ctx.ports.agreed(path, agreement);
  }

  private matchesDraftBlob(path: string, same: CacheEntry, draftBlob: string): Promise<boolean> {
    return matchesDraftBlobOnDisk(path, same, draftBlob, this.crlfMiss, (one, diskSha, blob) => this.isRemoteRoomBlob(one, diskSha, blob), (one) => this.ctx.ports.vault.read(one), () => this.ctx.current());
  }

  private async one(looked: Looked, path: string, draft: Draft | null, level: boolean): Promise<boolean> {
    const { ports } = this.ctx;
    const doc = ports.documentFor(path);
    if (!doc || (ports.inGroup(path) && draft?.inGroup !== true)) {
      this.unlevel.delete(path);
      this.clearUnsaved(path);
      return false;
    }
    const same = looked.files.get(path);
    if (draft !== null && isFreshLocalUntitled(path, same)) {
      this.offers.drop(path);
      this.unlevel.delete(path);
      this.clearUnsaved(path);
      return false;
    }
    if (
      draft &&
      draft.blob !== null &&
      same !== undefined &&
      !(same.sent === draft.blob && agreedOf(same) === same.sha && same.sentTo === (draftKey(draft) ?? undefined)) &&
      (follows(draft, ports.login(), same, this.policyFor(path, draft)) || this.isRemoteRoom(path, same.sha)) &&
      (await this.leftAlone(looked, path, { allowLive: true })) === null &&
      (await this.matchesDraftBlob(path, same, draft.blob))
    ) {
      const to = draftKey(draft);
      this.agreeDraft(path, same, { sent: draft.blob, to, agreed: same.sha });
      Object.assign(same, { sent: draft.blob, agreed: same.sha, ...(to === null ? {} : { sentTo: to }) });
      if (this.holds.isEditHeld(path, same.sha)) {
        this.holds.clearEditHold(path);
        this.rescan = true;
      }
      this.settled(path);
      this.clearConflict(path);
      this.ctx.onResolved?.(path);
      this.offers.drop(path);
      this.unlevel.delete(path);
      this.clearUnsaved(path);
      return false;
    }
    if (!draft && level && same?.sent !== undefined && !this.endedMemo.has(path) && same.base === same.sent && looked.repo.get(path) === same.sent && this.ctx.consumeRebasedSent?.(path, same.sent) === true) {
      ports.agreed(path, null);
      clearSent(same);
      this.settled(path);
      this.clearConflict(path);
      this.unlevel.delete(path);
      this.clearUnsaved(path);
      this.rescan = true;
      return false;
    }
    const memo = this.endedMemo.get(path);
    const repoSha = looked.repo.get(path);
    if (!draft && memo?.ended === "published" && memo.base !== undefined && same !== undefined && repoSha !== undefined && same.base === repoSha && memo.base !== same.base) {
      this.endedMemo.delete(path);
      this.settled(path);
      this.clearConflict(path);
      this.unlevel.delete(path);
      this.clearUnsaved(path);
      this.ctx.onResolved?.(path);
      this.rescan = true;
      return false;
    }
    const facts = this.facts(looked, path);
    const input = { file: memo && facts.sent === undefined ? { ...facts, sent: memo.sent } : facts, draft, login: ports.login(), policy: draft ? this.policyFor(path, draft) : ports.policy(), leftAlone: null, ended: memo?.ended ?? null } as const;
    const inboundWillHandle = input.file.publishedMoved && this.ctx.state.data.seen?.[path] !== looked.repo.get(path);
    let answer: Case = draftCase(input);
    let ended: Ended | null = memo?.ended ?? null;
    const entry = looked.files.get(path);
    if (draft || entry?.sent === undefined || level || memo || (answer.kind !== "none" && answer.kind !== "wait")) this.unlevel.delete(path);
    else {
      const now = ports.now();
      const until = stepBackoff(this.unlevel, path, now, UNLEVEL_ENDED_WAITS_MS);
      if (until !== null) this.wake.until(until, now);
    }
    if (!draft && entry?.sent !== undefined && level && !memo && ports.now() - (entry.sentAt ?? 0) <= ENDED_AFTER_MS && (answer.kind === "none" || answer.kind === "wait")) {
      this.wake.at(ENDED_AFTER_MS - (ports.now() - (entry.sentAt ?? 0)));
    }
    if (!draft && entry?.sent !== undefined && level && ports.now() - (entry.sentAt ?? 0) > ENDED_AFTER_MS && (answer.kind === "none" || answer.kind === "wait")) {
      if (this.renames.moving(looked, path, entry)) {
        this.waitEnd(path);
        return false;
      }
      const together = this.ends.get(path);
      if (!this.ready(path, together === undefined && !this.endsAsked.has(path))) return false;
      if (together === undefined && !this.endsAsked.has(path)) this.reads++;
      const end = together ?? (this.endsAsked.has(path) ? "unknown" : await ports.reviewEnd(doc, entry?.sentTo?.startsWith("group:") === true));
      if (!this.ctx.current()) return false;
      if (end === "unknown" || end === "open") {
        this.waitEnd(path, end === "unknown" && this.endsAsked.has(path) ? this.endsRetryAfterMs : undefined);
        return false;
      }
      if (end === "closed" || end === "closedUnnamed") return this.keepClosed(looked, path, end === "closedUnnamed");
      ended = end === "published" ? "published" : "discarded";
      answer = draftCase({ ...input, ended });
      if (answer.kind === "end-own" && entry?.sent !== undefined) {
        if (inboundWillHandle && ended === "published" && entry.sent === looked.repo.get(path)) this.ctx.noteOwnBlob?.(path, entry.sent);
        this.endedMemo.set(path, { sent: entry.sent, ended, base: entry.base });
        ports.agreed(path, null);
      }
    }
    const alone = draft && answer.kind === "settled" ? await this.leftAlone(looked, path) : null;
    if (draft && answer.kind === "settled" && (alone === null || alone === "live")) await this.attachments(path, doc, draft, alone === null);
    if (answer.kind === "settled" || answer.kind === "none") this.clearConflict(path);
    else if (answer.kind === "send" && draft?.blob !== null && !this.ctx.hasConflict?.(path, looked)) this.clearConflict(path);
    const canDropOffer = (draft !== null && draft.blob !== null) || (draft === null && level);
    const heldMeet = this.isHeldMeet(answer.kind, path, entry);
    const readsDraft = answer.kind === "take" || answer.kind === "create" || answer.kind === "merge" || heldMeet;
    if (!readsDraft && !["offer", "settle", "restore", "end-own"].includes(answer.kind)) {
      if (answer.kind === "send") this.readyToSend.add(path);
      if (canDropOffer) this.offers.drop(path);
      this.clearUnsaved(path);
      return false;
    }
    if (answer.kind === "end-own" && inboundWillHandle) {
      if (canDropOffer) this.offers.drop(path);
      this.clearUnsaved(path);
      return false;
    }
    const left = await this.leftAlone(looked, path);
    if (!this.ctx.current()) return false;
    if (left !== null) {
      if (left === "unsaved") this.deferUnsaved(path);
      else this.clearUnsaved(path);
      return false;
    }
    this.clearUnsaved(path);
    if (answer.kind === "offer") {
      if (!facts.present && this.caseIndex.collision(path) !== null) return false;
      this.offers.offer(path, looked.drafts?.byPath.get(path) ?? draft);
      return false;
    }
    if (canDropOffer) this.offers.drop(path);
    if (answer.kind === "create" && this.caseIndex.collision(path) !== null) {
      this.holdCaseCollision(path, draft?.blob ?? draft?.branch ?? "");
      return false;
    }
    if (readsDraft && isSkippableDraftMerge(answer.kind, path, entry, draft?.blob ?? null, (p, b) => this.told(p, b), (p, s) => this.holds.isEditHeld(p, s), this.cleanMerges)) {
      return false;
    }
    const batched = (["settle", "restore", "end-own"].includes(answer.kind) && this.mainOf(path) !== null) || (draft !== null && readsDraft && this.draftOf(draft) !== null);
    if (readsDraft && (this.draftsDeferred.has(path) || this.draftOps >= DRAFTS_PER_PASS)) {
      this.cut = true;
      return false;
    }
    if (!this.ready(path, !batched)) return false;
    if (readsDraft) this.draftOps++;
    await yieldQuiet(this.ctx);
    if (!this.ctx.current()) return false;
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
        case "meet":
          return await this.mergeOrClassify(path, doc, looked, draft!);
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
    this.ctx.ports.agreed(path, null);
    this.ctx.clearOwnBlobs?.(path);
    if (this.holds.holdClosedElsewhere(looked, path)) this.closedNow.push({ name: noteName(path), unnamed });
    this.settled(path);
    return false;
  }

  private tellClosed(): void {
    if (this.closedNow.length === 0) return;
    const closed = this.closedNow.splice(0);
    this.ctx.ports.notify(DRAFT_SAID.closedElsewhere(closed.map((one) => one.name), closed.some((one) => one.unnamed) ? "unknown" : "someone else"), { label: DRAFT_SAID.closedElsewhereButton, run: () => this.ctx.ports.openStatus?.() }, { lasting: true });
  }

  private async attachments(path: string, doc: DocumentRef, draft: Draft, replace = true): Promise<void> {
    const { ports } = this.ctx;
    const done = this.attachmentsFor.get(path);
    if (!ports.bringAttachments || draft.blob === null || (done?.blob === draft.blob && (done.replaced || !replace))) return;
    const text = await ports.vault.read(path);
    if (text === null || !this.ctx.current()) return;
    let completed = false;
    try {
      await ports.bringAttachments(doc, draft.branch, path, text, (words) => ((completed = true), ports.attachmentRow?.(path, words)), { replace });
    } catch {
      ports.diagnose("the attachments of a draft could not be brought in");
    }
    if (!this.ctx.current()) return;
    if (completed) {
      this.attachmentWaits.delete(path);
      this.attachmentsFor.set(path, { blob: draft.blob, replaced: replace || (done?.blob === draft.blob && done.replaced) });
      return;
    }
    const until = stepBackoff(this.attachmentWaits, path, ports.now(), UNLEVEL_ENDED_WAITS_MS);
    if (until !== null) this.wake.until(until, ports.now());
  }

  noteInitial(looked: Looked): void {
    if (looked.drafts) this.offers.noteInitial(looked, looked.drafts);
  }

  policyFor(path: string, draft: Pick<Draft, "blob">): StayDrafts {
    return this.offers.policyFor(path, draft);
  }

  offered(): readonly string[] {
    return this.offers.offered();
  }

  addAllOffered(): void {
    this.offers.addAll();
  }

  livened(isLive: (path: string) => boolean): void {
    this.offers.livened(isLive);
  }

  addNow(looked: Looked, path: string): Promise<void> {
    this.looked = looked;
    return this.settleNow(path);
  }

  private writeText(
    path: string,
    mine: string,
    target: string,
    options: { confirmed?: boolean; notifyOnFail?: boolean } = {},
  ): Promise<{ ok: true; text: string; changed: boolean } | { ok: false }> {
    return writeDraftText(this.ctx.ports, this.ctx.activity, path, mine, target, (one) => this.wait(one), options);
  }

  private async readDraft(path: string, doc: DocumentRef, draft: Draft): Promise<Extract<BranchFile, { kind: "file" }> | null> {
    const together = this.draftOf(draft);
    if (together === null) this.reads++;
    const there = together ?? (await this.ctx.ports.draftFile(doc, draft.branch));
    if (!this.ctx.current()) return null;
    if (there.kind !== "file") {
      this.wait(path);
      return null;
    }
    if (this.policyFor(path, draft) === "mine" && draft.blob !== there.sha) {
      this.wait(path);
      return null;
    }
    return there;
  }

  private async take(path: string, doc: DocumentRef, looked: Looked, draft: Draft): Promise<boolean> {
    const { ports } = this.ctx;
    const entry = looked.files.get(path)!;
    const there = await this.readDraft(path, doc, draft);
    if (there === null) return false;
    const mine = await ports.vault.read(path);
    if (mine === null || gitBlobShaOfText(mine) !== entry.sha) return false;
    const wrote = await this.writeText(path, mine, there.text);
    if (!wrote.ok) return false;
    this.agreeDraft(path, entry, { sent: there.sha, to: draftKey(draft), agreed: gitBlobShaOfText(wrote.text) });
    this.settled(path);
    this.clearConflict(path);
    this.ctx.onResolved?.(path);
    return wrote.changed;
  }

  private async create(path: string, doc: DocumentRef, draft: Draft): Promise<boolean> {
    const { ports, activity, state } = this.ctx;
    const there = await this.readDraft(path, doc, draft);
    if (there === null) return false;
    activity.ownWrite(path);
    const made = await ports.vault.create(path, there.text);
    if (made !== "created") {
      activity.notWritten(path);
      if (made === "exists" && !ports.vault.exists(path)) {
        this.holdCaseCollision(path, there.sha);
        return false;
      }
      this.wait(path);
      return false;
    }
    this.caseIndex.add(path);
    state.data.committed.push(changeKey({ kind: "new", path }));
    this.awaiting.set(path, { sent: there.sha, to: draftKey(draft), agreed: gitBlobShaOfText(there.text) });
    this.settled(path);
    return true;
  }

  private readBase(path: string, doc: DocumentRef, entry: Pick<CacheEntry, "sent" | "base"> | undefined, draft: Pick<Draft, "branch" | "prNumber" | "inGroup">, countRead = false): Promise<string | null> {
    return readDraftMergeBase(this.ctx.ports, path, doc, entry, draft, countRead ? () => void this.reads++ : undefined);
  }

  private async mergeOrClassify(path: string, doc: DocumentRef, looked: Looked, draft: Draft): Promise<boolean> {
    const { ports } = this.ctx;
    const entry = looked.files.get(path)!;
    if (this.told(path, draft.blob)) return false;
    const there = await this.readDraft(path, doc, draft);
    if (there === null) return false;
    const mine = await ports.vault.read(path);
    if (!this.ctx.current() || mine === null || gitBlobShaOfText(mine) !== entry.sha) return false;
    const base = await this.readBase(path, doc, entry, draft, true);
    if (!this.ctx.current()) return false;
    if (base === null) {
      this.wait(path);
      return false;
    }
    const merged = mergeFile(path, stripBom(toLf(base)), stripBom(toLf(mine)), stripBom(toLf(there.text)), new Budget(400));
    if (merged.kind === "conflict") {
      this.cleanMerges.delete(path);
      this.tellConflict(path, there.sha);
      this.settled(path);
      return false;
    }
    if (!this.holds.isEditHeld(path, entry.sha)) {
      const cleanKey = `${entry.sha}|${draft.blob ?? there.sha}`;
      if (this.cleanMerges.get(path) !== cleanKey) {
        this.cleanMerges.set(path, cleanKey);
        this.progressed = true;
      }
      this.clearConflict(path);
      this.settled(path);
      return false;
    }
    const wrote = await this.writeText(path, mine, merged.text);
    if (!wrote.ok) return false;
    const nextSha = gitBlobShaOfText(wrote.text);
    const holdsDraft = stripBom(toLf(wrote.text)) === stripBom(toLf(there.text));
    this.agreeDraft(path, entry, { sent: there.sha, to: draftKey(draft), ...(holdsDraft ? { agreed: nextSha } : {}) });
    if (holdsDraft) this.holds.clearEditHold(path);
    else this.holds.advanceEditHold(path, entry.sha, nextSha);
    if (!wrote.changed) this.rescan = true;
    this.settled(path);
    this.clearConflict(path);
    if (holdsDraft) this.ctx.onResolved?.(path);
    await this.attachments(path, doc, draft);
    return wrote.changed;
  }

  private async end(path: string, doc: DocumentRef, looked: Looked, kind: "settle" | "restore" | "end-own", discarded: boolean, choose = false): Promise<boolean> {
    const { ports, state } = this.ctx;
    const entry = looked.files.get(path)!;
    const batched = this.mainOf(path);
    if (batched === null) this.reads++;
    const main = batched ?? (await ports.gitFile(doc));
    if (!this.ctx.current()) return false;
    if (main.kind === "unreadable") {
      if (choose) ports.notify(CHOOSE_UNREADABLE);
      this.wait(path);
      return false;
    }
    if (main.kind === "absent") {
      if (this.renames.moving(looked, path, entry)) {
        this.waitEnd(path);
        return false;
      }
      await this.deletes.absentMain(path, doc, entry.sha, looked, kind);
      return false;
    }
    const mine = await ports.vault.read(path);
    if (mine === null || (!choose && gitBlobShaOfText(mine) !== entry.sha)) {
      if (choose && mine === null) ports.notify(CHOOSE_UNREADABLE);
      return false;
    }
    let target = main.text;
    if (kind === "end-own") {
      const sentSha = this.endedMemo.get(path)?.sent ?? entry.sent!;
      const base = sentSha === main.sha ? main.text : (this.reads++, await ports.blobText(doc, sentSha));
      const merged = mergeFile(path, base === null ? null : stripBom(toLf(base)), stripBom(toLf(mine)), stripBom(toLf(main.text)), new Budget(400));
      if (merged.kind === "conflict") {
        if (!choose) {
          this.tellConflict(path, `ended|${main.sha}`);
          return false;
        }
        const chosen = await ports.chooseWhatToKeep(buildReviewRequest(path, merged.review, { other: "github", signal: this.abort.signal }));
        if (chosen === null || !this.ctx.current()) return false;
        target = chosen;
      } else target = merged.text;
    }
    const wrote = await this.writeText(path, mine, target, { confirmed: choose, notifyOnFail: choose });
    if (!wrote.ok) return false;
    ports.recordBase(path, doc, toLf(main.text), main.text);
    ports.rebase(path, main.sha);
    if (state.data.seen) state.data.seen[path] = main.sha;
    ports.agreed(path, null);
    this.ctx.clearOwnBlobs?.(path);
    this.endedMemo.delete(path);
    if (kind === "end-own" && discarded) this.holds.holdEnded(path, gitBlobShaOfText(wrote.text));
    this.settled(path);
    this.clearConflict(path);
    this.ctx.onResolved?.(path);
    if (kind === "restore" && wrote.changed) ports.notify(DRAFT_SAID.discarded(noteName(path)));
    if (choose && !wrote.changed) ports.notify(CHOOSE_MATCHED);
    if (!wrote.changed) this.rescan = true;
    return wrote.changed;
  }

  private settleNow(path: string): Promise<void> {
    this.offers.drop(path, { keepTold: true });
    if (!this.ctx.current() || this.deciding.has(path)) return Promise.resolve();
    const looked = this.looked;
    if (!looked) {
      this.ctx.ports.notify(CHOOSE_UNREADABLE);
      this.ctx.ports.lookAgain();
      return Promise.resolve();
    }
    const draft = looked.drafts?.byPath.get(path);
    const doc = this.ctx.ports.documentFor(path);
    if (!doc || (!draft && looked.files.get(path)?.sent === undefined && !this.endedMemo.has(path))) {
      this.clearConflict(path);
      this.ctx.onResolved?.(path);
      this.ctx.ports.notify(CHOOSE_MATCHED);
      this.ctx.ports.lookAgain();
      return Promise.resolve();
    }
    this.deciding.add(path);
    this.queue = this.queue.then(async () => {
      const { ports } = this.ctx;
      try {
        if (!this.ctx.current() || this.abort.signal.aborted) return;
        if (ports.phaseOf(path) !== "local") {
          const mainMoved = looked.repo.has(path) && looked.files.get(path)?.base !== looked.repo.get(path);
          if (draft && ports.phaseOf(path) === "live" && mainMoved && !(await ports.vault.hasUnsavedText(path))) ports.settleReview(path);
          else ports.notify(CHOOSE_BLOCKED);
          return;
        }
        if (!draft) {
          await this.end(path, doc, looked, "end-own", false, true);
          ports.lookAgain();
          return;
        }
        const there = await ports.draftFile(doc, draft.branch);
        const mine = await ports.vault.read(path);
        if (!this.ctx.current()) return;
        if (there.kind === "absent") {
          this.clearConflict(path);
          this.ctx.onResolved?.(path);
          ports.notify(CHOOSE_MATCHED);
          ports.lookAgain();
          return;
        }
        if (there.kind !== "file" || mine === null) {
          ports.notify(CHOOSE_UNREADABLE);
          ports.lookAgain();
          return;
        }
        const entry = looked.files.get(path);
        if (isFreshLocalUntitled(path, entry)) return;
        if (stripBom(toLf(mine)) === stripBom(toLf(there.text))) {
          this.agreeDraft(path, entry, { sent: there.sha, to: draftKey(draft), agreed: gitBlobShaOfText(mine) });
          this.clearConflict(path);
          this.ctx.onResolved?.(path);
          ports.notify(CHOOSE_MATCHED);
          ports.lookAgain();
          return;
        }
        const base = await this.readBase(path, doc, entry, draft);
        if (!this.ctx.current()) return;
        const merged = mergeFile(path, base === null ? null : stripBom(toLf(base)), stripBom(toLf(mine)), stripBom(toLf(there.text)), new Budget(400));
        const mineSha = gitBlobShaOfText(mine);
        const clean = this.isRemoteRoom(path, mineSha) || (entry !== undefined && mineSha === entry.sha && isClean({ sha: entry.sha, ...(agreedOf(entry) !== undefined ? { agreed: agreedOf(entry)! } : {}), unchanged: unchangedHere(entry) }));
        let chosen: string | null;
        if (clean) chosen = there.text;
        else if (merged.kind === "clean") chosen = merged.text;
        else {
          const writer = draftWriter(draft);
          const other = writer !== null && writer.toLowerCase() !== ports.login().toLowerCase() ? { teammate: writer } : ("github" as const);
          chosen = await ports.chooseWhatToKeep(buildReviewRequest(path, merged.review, { other, signal: this.abort.signal }));
        }
        if (chosen === null || !this.ctx.current()) return;
        const wrote = await this.writeText(path, mine, chosen, { confirmed: true, notifyOnFail: true });
        if (!wrote.ok) return;
        const holdsDraft = stripBom(toLf(wrote.text)) === stripBom(toLf(there.text));
        this.agreeDraft(path, entry, { sent: there.sha, to: draftKey(draft), ...(holdsDraft ? { agreed: gitBlobShaOfText(wrote.text) } : {}) });
        this.clearConflict(path);
        this.ctx.onResolved?.(path);
        ports.lookAgain();
      } catch {
        ports.diagnose(draft ? "a choice between a note and its draft could not be applied" : "a choice between a note and the published version could not be applied");
        ports.notify(CHOOSE_UNREADABLE);
      } finally {
        this.deciding.delete(path);
      }
    });
    return this.queue;
  }
}
