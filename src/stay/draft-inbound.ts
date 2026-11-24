import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf, type CacheEntry } from "../changes/cache";
import type { Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { Budget } from "../disk/diff";
import { eolOf, toLf, withEol } from "../disk/line-endings";
import { buildReviewRequest, mergeFile } from "../disk/structured-merge";
import { CasePathIndex, type DocumentRef, noteName } from "../mapping";
import type { Activity } from "./activity";
import { type Case, draftCase, type Draft, draftKey, type Ended, type FileFacts, follows, isClean, type LeftAlone, type StayDrafts } from "./draft-state";
import type { BranchFile, MainFile } from "../auth/git-copy";
import { DraftDeletes } from "./draft-deletes";
import { TeammateOffers } from "./draft-offers";
import { DraftRenames, RENAME_HOLD_MS } from "./draft-renames";
import type { End } from "./ends";
import { caseCollisionWords, StayHolds, vaultCaseIndex } from "./holds";
import { FIRST_WAIT_MS, MAX_WAIT_MS, READS_PER_PASS, TEXTS_PER_PASS } from "./inbound";
import { changeKey } from "./outbound";
import type { StayState } from "./state";
import type { StayPorts } from "./types";
import { BackoffWaits, WakeClock } from "./wait";
import { CHOICE_WORDS, DRAFT_SAID } from "./words";

export const RECENT_MS = 5_000;
export const ENDED_AFTER_MS = 60_000;
export const UNLEVEL_ENDED_WAITS_MS = [10_000, 20_000, 40_000, 80_000, 120_000] as const;
export const UNSAVED_WAITS_MS = [5_000, 10_000, 20_000, 40_000] as const;

export const TRANSIT_MS = 2_000;

export { RENAME_HOLD_MS };

export interface DraftContext {
  ports: StayPorts;
  state: StayState;
  activity: Activity;
  holds?: StayHolds;
  current(): boolean;
}

export interface DraftPass {
  changed: number;
  rescan: boolean;
  more: boolean;
  wake: number | null;
  heldFrom: ReadonlySet<string>;
}

export class DraftInbound {
  private reads = 0;
  private cut = false;
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
  private readonly noticed = new Set<string>();
  private readonly offers: TeammateOffers;
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
  private readonly deciding = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();

  private readonly renames: DraftRenames;
  private readonly deletes: DraftDeletes;

  constructor(private readonly ctx: DraftContext) {
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
      spendRead: () => void this.reads++,
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
    if (this.holds.holdCaseCollision(path, key)) this.ctx.ports.notify(caseCollisionWords(noteName(path)));
    this.settled(path);
  }

  stop(): void {
    this.abort.abort();
    this.offers.stop();
    this.unsaved.clear();
    this.deferredUnsaved.clear();
    this.deferredRenameSources = new Set();
  }

  tellConflict(path: string, blob: string | null): void {
    if (blob !== null && this.toldConflict.get(path) === blob) return;
    if (blob !== null) this.toldConflict.set(path, blob);
    if (this.noticed.has(path)) return;
    this.noticed.add(path);
    if (!this.ctx.ports.aware()) {
      this.ctx.ports.notify(DRAFT_SAID.conflict(noteName(path)), { label: DRAFT_SAID.chooseButton, run: () => void this.settleNow(path) }, { lasting: true });
      return;
    }
    this.ctx.ports.choice?.(path, { words: CHOICE_WORDS.draft, label: CHOICE_WORDS.choose, run: () => void this.settleNow(path) });
    this.ctx.ports.notify(DRAFT_SAID.conflict(noteName(path)), { label: CHOICE_WORDS.show, run: () => this.ctx.ports.openStatus?.() }, { lasting: true });
  }

  private clearConflict(path: string): void {
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
    let known = this.unsaved.get(path);
    if (!known || (now >= known.until && known.strikes < UNSAVED_WAITS_MS.length)) {
      const strikes = known ? known.strikes : 0;
      known = { strikes: strikes + 1, until: now + UNSAVED_WAITS_MS[strikes]! };
      this.unsaved.set(path, known);
    }
    if (now < known.until) this.wake.until(known.until, now);
  }

  private clearUnsaved(path: string): void {
    this.deferredUnsaved.delete(path);
    this.unsaved.delete(path);
  }

  told(path: string, blob: string | null): boolean {
    return blob !== null && this.toldConflict.get(path) === blob;
  }

  async readOne(looked: Looked, path: string): Promise<{ changed: number; rescan: boolean; wake: number | null }> {
    const draft = looked.drafts?.byPath.get(path);
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.reads = 0;
    this.cut = false;
    this.rescan = false;
    this.wake.reset();
    if (!looked.drafts) return { changed: 0, rescan: false, wake: null };
    if (draft && !looked.files.has(path) && this.renames.mayBeRename(looked, looked.drafts.byPath, path, draft) && this.renames.holding(path)) {
      this.ctx.ports.lookAgain();
      return { changed: 0, rescan: false, wake: null };
    }
    this.forgetReads();
    const moved = draft ? { ...draft, blob: "" } : null;
    const changed = ((await this.one(looked, path, moved, looked.drafts.level)) ? 1 : 0) + (await this.deletes.flush(looked));
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, rescan: this.rescan, wake: this.wake.value() };
  }

  async readEnded(looked: Looked, path: string): Promise<{ changed: number; rescan: boolean; wake: number | null }> {
    this.forgetReads();
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.reads = 0;
    this.cut = false;
    this.rescan = false;
    this.wake.reset();
    const changed = ((await this.one(looked, path, null, true)) ? 1 : 0) + (await this.deletes.flush(looked));
    this.tellClosed();
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, rescan: this.rescan, wake: this.wake.value() };
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

  async run(looked: Looked, known: (sha: string) => string | undefined = () => undefined): Promise<DraftPass> {
    const drafts = looked.drafts;
    this.looked = looked;
    this.caseIndex = vaultCaseIndex(looked, this.ctx.ports.vault);
    this.known = known;
    this.reads = 0;
    this.cut = false;
    this.rescan = false;
    this.wake.reset();
    this.deferredRenameSources = new Set();
    let changed = this.keepAwaiting(looked);
    if (!drafts) return { changed, rescan: false, more: false, wake: null, heldFrom: this.deferredRenameSources };
    this.holds.pruneCaseCollisions(looked, this.caseIndex);
    this.offers.noteInitial(looked, drafts);
    await this.backfill(looked);
    this.deletes.dropGone(looked);
    this.renames.dropSettled(looked, drafts.byPath);
    const renamed = await this.renames.pair(looked, drafts.byPath);
    this.deferredRenameSources = renamed.heldFrom;
    changed += renamed.changed;
    const paths = new Set<string>([...drafts.byPath.keys(), ...this.endedMemo.keys(), ...[...looked.files].filter(([, entry]) => entry.sent !== undefined).map(([path]) => path)]);
    const skip = new Set<string>([...renamed.paths, ...renamed.heldFrom]);
    await this.readEnds(looked, paths, drafts, skip);
    await this.readDrafts(looked, paths, drafts, skip);
    for (const path of [...this.unlevel.keys()]) if (!paths.has(path)) this.unlevel.delete(path);
    for (const path of [...this.deferredUnsaved]) if (!paths.has(path) && !renamed.heldFrom.has(path)) this.clearUnsaved(path);
    for (const path of [...this.unsaved.keys()]) if (!paths.has(path) && !renamed.heldFrom.has(path)) this.unsaved.delete(path);
    for (const path of paths) {
      if (!this.ctx.current()) break;
      if (skip.has(path)) continue;
      if (await this.one(looked, path, drafts.byPath.get(path) ?? null, drafts.level)) changed++;
    }
    changed += await this.deletes.flush(looked);
    this.offers.tell(drafts);
    this.tellClosed();
    this.deletes.tellKept();
    this.ctx.state.save();
    return { changed, rescan: this.rescan, more: this.cut, wake: this.wake.value(), heldFrom: this.deferredRenameSources };
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

  private async leftAlone(looked: Looked, path: string, options?: { allowLive?: boolean; transientOnly?: boolean }): Promise<LeftAlone | null> {
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
        this.wake.at(RECENT_MS - age);
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
      if (wanted.length >= TEXTS_PER_PASS) break;
    }
    if (wanted.length > 0) this.texts = await ports.blobTexts(wanted);
  }

  private async readDrafts(looked: Looked, paths: ReadonlySet<string>, drafts: NonNullable<Looked["drafts"]>, skip: ReadonlySet<string>): Promise<void> {
    const { ports } = this.ctx;
    this.draftTexts = new Map();
    this.draftsDeferred = new Set();
    if (!ports.draftTexts || !drafts.level) return;
    const asked: Array<{ doc: DocumentRef; sha: string }> = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (skip.has(path)) continue;
      const draft = drafts.byPath.get(path);
      const doc = ports.documentFor(path);
      if (!draft || !draft.blob || !doc || (ports.inGroup(path) && draft.inGroup !== true) || seen.has(draft.blob)) continue;
      const entry = looked.files.get(path);
      if (!entry && this.caseIndex.collision(path) !== null) continue;
      if (entry?.sent !== undefined && !(drafts.asOf !== undefined && drafts.asOf > (entry.sentAt ?? 0) + TRANSIT_MS)) continue;
      const kind = draftCase({ file: this.facts(looked, path), draft, login: ports.login(), policy: this.policyFor(path, draft), leftAlone: null, ended: null }).kind;
      const readsDraft = kind === "take" || kind === "create" || kind === "merge" || this.isHeldMeet(kind, path, entry);
      if (!readsDraft || !this.ready(path, false)) continue;
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
    if (this.waiting.waiting(path, undefined, this.wake)) return false;
    if (!pairing && this.endWaiting.waiting(path, undefined, this.wake)) return false;
    if (spend && this.reads >= READS_PER_PASS) {
      this.cut = true;
      return false;
    }
    return true;
  }

  private wait(path: string): void {
    this.waiting.defer(path, undefined, this.wake);
  }

  private waitEnd(path: string, retryAfterMs?: number): void {
    this.endWaiting.defer(path, undefined, this.wake, retryAfterMs);
  }

  private settled(path: string): void {
    this.waiting.delete(path);
    this.endWaiting.delete(path);
  }

  private isHeldMeet(kind: Case["kind"], path: string, entry: Pick<CacheEntry, "sha" | "base"> | undefined): boolean {
    return kind === "meet" && entry !== undefined && entry.base !== null && this.holds.isEditHeld(path, entry.sha);
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
    if (draft && draft.blob !== null && same !== undefined && same.sha === draft.blob && !(same.sent === draft.blob && agreedOf(same) === same.sha && same.sentTo === (draftKey(draft) ?? undefined)) && follows(draft, ports.login(), same.sentTo, this.policyFor(path, draft)) && (await this.leftAlone(looked, path, { allowLive: true })) === null) {
      const to = draftKey(draft);
      ports.agreed(path, { sent: draft.blob, to, agreed: same.sha });
      Object.assign(same, { sent: draft.blob, agreed: same.sha, ...(to === null ? {} : { sentTo: to }) });
      this.settled(path);
      this.clearConflict(path);
      this.offers.drop(path);
      this.unlevel.delete(path);
      this.clearUnsaved(path);
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
      if (now < known.until) this.wake.until(known.until, now);
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
        this.endedMemo.set(path, { sent: entry.sent, ended });
        ports.agreed(path, null);
      }
    }
    const alone = draft && answer.kind === "settled" ? await this.leftAlone(looked, path) : null;
    if (draft && answer.kind === "settled" && (alone === null || alone === "live")) await this.attachments(path, doc, draft, alone === null);
    if (answer.kind === "settled" || answer.kind === "send" || answer.kind === "none") this.clearConflict(path);
    const canDropOffer = (draft !== null && draft.blob !== null) || (draft === null && level);
    const heldMeet = this.isHeldMeet(answer.kind, path, entry);
    const readsDraft = answer.kind === "take" || answer.kind === "create" || answer.kind === "merge" || heldMeet;
    if (!readsDraft && !["offer", "settle", "restore", "end-own"].includes(answer.kind)) {
      if (canDropOffer) this.offers.drop(path);
      this.clearUnsaved(path);
      return false;
    }
    if (answer.kind === "end-own" && input.file.publishedMoved) {
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
    const batched = (["settle", "restore", "end-own"].includes(answer.kind) && this.mainOf(path) !== null) || (draft !== null && readsDraft && this.draftOf(draft) !== null);
    if (this.draftsDeferred.has(path) && readsDraft) {
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

  private async writeText(
    path: string,
    mine: string,
    target: string,
    options: { confirmed?: boolean; notifyOnFail?: boolean } = {},
  ): Promise<{ ok: true; text: string; changed: boolean } | { ok: false }> {
    const { ports, activity } = this.ctx;
    const targetLf = toLf(target);
    if (toLf(mine) === targetLf) return { ok: true, text: mine, changed: false };
    const text = withEol(targetLf, eolOf(mine));
    activity.ownWrite(path);
    const written = await ports.vault.process(path, (current) => (current === mine ? text : null), options.confirmed ? { confirmed: true } : undefined);
    if (written !== "written") {
      activity.notWritten(path);
      if (options.notifyOnFail) ports.notify(DRAFT_SAID.notApplied(noteName(path)));
      else this.wait(path);
      return { ok: false };
    }
    return { ok: true, text, changed: true };
  }

  private async take(path: string, doc: DocumentRef, looked: Looked, draft: Draft): Promise<boolean> {
    const { ports } = this.ctx;
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
    const wrote = await this.writeText(path, mine, there.text);
    if (!wrote.ok) return false;
    ports.agreed(path, { sent: there.sha, to: draftKey(draft), agreed: gitBlobShaOfText(wrote.text) });
    this.settled(path);
    this.clearConflict(path);
    return wrote.changed;
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

  private async readBase(path: string, doc: DocumentRef, entry: Pick<CacheEntry, "sent" | "base"> | undefined, draft: Pick<Draft, "branch" | "prNumber" | "inGroup">, countRead = false): Promise<string | null> {
    const { ports } = this.ctx;
    if (ports.localSentBase) {
      const local = await ports.localSentBase(path, doc, draft);
      if (local !== null) return local;
    }
    if (entry?.sent !== undefined) {
      const cached = ports.baseText(path, entry.sent);
      if (cached !== null) return cached;
      if (countRead) this.reads++;
      return ports.blobText(doc, entry.sent);
    }
    if (!entry || entry.base === null || !ports.draftBase) return null;
    if (countRead) this.reads++;
    const fork = await ports.draftBase(doc, draft.branch);
    if (fork === null) return null;
    const matchesBase = gitBlobShaOfText(fork.base) === entry.base;
    const matchesMain = fork.main !== "" && gitBlobShaOfText(fork.main) === entry.base;
    return matchesBase || matchesMain ? fork.base : null;
  }

  private async mergeOrClassify(path: string, doc: DocumentRef, looked: Looked, draft: Draft): Promise<boolean> {
    const { ports } = this.ctx;
    const entry = looked.files.get(path)!;
    if (draft.blob !== null && this.toldConflict.get(path) === draft.blob) return false;
    const together = this.draftOf(draft);
    if (together === null) this.reads++;
    const there = together ?? (await ports.draftFile(doc, draft.branch));
    if (!this.ctx.current()) return false;
    if (there.kind !== "file") {
      this.wait(path);
      return false;
    }
    const mine = await ports.vault.read(path);
    if (!this.ctx.current() || mine === null || gitBlobShaOfText(mine) !== entry.sha) return false;
    const base = await this.readBase(path, doc, entry, draft, true);
    if (!this.ctx.current()) return false;
    if (base === null) {
      this.wait(path);
      return false;
    }
    const merged = mergeFile(path, toLf(base), toLf(mine), toLf(there.text), new Budget(400));
    if (merged.kind === "conflict") {
      this.tellConflict(path, there.sha);
      this.settled(path);
      return false;
    }
    if (!this.holds.isEditHeld(path, entry.sha)) {
      this.clearConflict(path);
      this.settled(path);
      return false;
    }
    const wrote = await this.writeText(path, mine, merged.text);
    if (!wrote.ok) return false;
    const nextSha = gitBlobShaOfText(wrote.text);
    const holdsDraft = toLf(wrote.text) === toLf(there.text);
    ports.agreed(path, { sent: there.sha, to: draftKey(draft), ...(holdsDraft ? { agreed: nextSha } : {}) });
    if (holdsDraft) this.holds.clearEditHold(path);
    else this.holds.advanceEditHold(path, entry.sha, nextSha);
    if (!wrote.changed) this.rescan = true;
    this.settled(path);
    this.clearConflict(path);
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
    if (mine === null || gitBlobShaOfText(mine) !== entry.sha) return false;
    let target = main.text;
    if (kind === "end-own") {
      const sentSha = this.endedMemo.get(path)?.sent ?? entry.sent!;
      const base = sentSha === main.sha ? main.text : (this.reads++, await ports.blobText(doc, sentSha));
      const merged = mergeFile(path, base === null ? null : toLf(base), toLf(mine), toLf(main.text), new Budget(400));
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
    this.endedMemo.delete(path);
    if (kind === "end-own" && discarded) this.holds.holdEnded(path, gitBlobShaOfText(wrote.text));
    this.settled(path);
    this.clearConflict(path);
    if (kind === "restore" && wrote.changed) ports.notify(DRAFT_SAID.discarded(noteName(path)));
    if (!wrote.changed) this.rescan = true;
    return wrote.changed;
  }

  private settleNow(path: string): Promise<void> {
    this.offers.drop(path, { keepTold: true });
    const looked = this.looked;
    if (!looked || !this.ctx.current() || this.deciding.has(path)) return Promise.resolve();
    const draft = looked.drafts?.byPath.get(path);
    const doc = this.ctx.ports.documentFor(path);
    if (!doc) return Promise.resolve();
    if (!draft) {
      if (looked.files.get(path)?.sent === undefined && !this.endedMemo.has(path)) return Promise.resolve();
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
      return this.queue;
    }
    this.deciding.add(path);
    this.queue = this.queue.then(async () => {
      const { ports } = this.ctx;
      try {
        if (!this.ctx.current() || this.abort.signal.aborted) return;
        const there = await ports.draftFile(doc, draft.branch);
        const mine = await ports.vault.read(path);
        if (there.kind !== "file" || mine === null || !this.ctx.current()) return;
        const entry = looked.files.get(path);
        const base = await this.readBase(path, doc, entry, draft);
        if (!this.ctx.current()) return;
        const merged = mergeFile(path, base === null ? null : toLf(base), toLf(mine), toLf(there.text), new Budget(400));
        const clean = entry !== undefined && gitBlobShaOfText(mine) === entry.sha && isClean({ sha: entry.sha, ...(agreedOf(entry) !== undefined ? { agreed: agreedOf(entry)! } : {}), unchanged: unchangedHere(entry) });
        let chosen: string | null;
        if (clean) chosen = there.text;
        else if (merged.kind === "clean") chosen = merged.text;
        else {
          const other = draft.by !== null && draft.by.toLowerCase() !== ports.login().toLowerCase() ? { teammate: draft.by } : ("github" as const);
          chosen = await ports.chooseWhatToKeep(buildReviewRequest(path, merged.review, { other, signal: this.abort.signal }));
        }
        if (chosen === null || !this.ctx.current()) return;
        const wrote = await this.writeText(path, mine, chosen, { confirmed: true, notifyOnFail: true });
        if (!wrote.ok) return;
        const holdsDraft = toLf(wrote.text) === toLf(there.text);
        ports.agreed(path, { sent: there.sha, to: draftKey(draft), ...(holdsDraft ? { agreed: gitBlobShaOfText(wrote.text) } : {}) });
        this.clearConflict(path);
        ports.lookAgain();
      } catch {
        ports.diagnose("a choice between a note and its draft could not be applied");
      } finally {
        this.deciding.delete(path);
      }
    });
    return this.queue;
  }
}
