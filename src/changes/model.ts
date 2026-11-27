import { ALL_SELECTED, applyPending, AskAgain, CHANGE_GRACE_MS, type ChangeSetEntry, type GroupOverview, type InFlightChange, type InFlightResponse, isGroupBranch, isSelected, type PendingChange, type PublishQuota, sameLogin, stillPending, expectArrival, forgetJoined, freshSelectionMemory, keepSelection, reviewSections, reviewStage, selectableUnits, selectAllKeys, selectionUnits, settleArrivals, type SavesTo, type SelectionMemory, withSelection, selectKeys, selectOnlyKey, type StatusGroup, statusUnits, unitKey } from "../shared/review-flow";
import { isHiddenPath, LISTED_FILE } from "../mapping";
import type { GroupsRead, PresenceRead, ReviewStatus } from "../review/review-api";
import { Awareness, awareLayout, type AwareLine, type HeldDeletes, type NoteChoice, withChoice } from "./awareness";
import { agreedOf } from "./cache";

export type { AwareLine, NoteChoice };
export type { ChangeRow, ChangesDeps, ChangesPhase, ChangesSectionId, ChangesState, Doing, GroupInfo, Looked } from "./model-types";
import type { ChangeRow, ChangesDeps, ChangesState, Looked } from "./model-types";

import { type BatchReview, draftOf, removalsByBranch, reviewFromInFlight, teammateReviews } from "./batch-reviews";
import { draftKey, draftWriter, type Draft } from "../stay/draft-state";
import { hasOwnOrAgreedDraft } from "../stay/outbound";
import { changeOf, type LocalChange, type LocalChangeKind, localChanges } from "./plan";
import type { CopyInFile, CopyInOptions } from "./copy-in";
import { isAttachmentPath } from "../shared/review-flow";
import { isLeftOutKind, leftOutKinds, NOTHING_LEFT_OUT } from "./left-out";
import { settleSameness } from "./same-text";
import { writesOffWords } from "../review/words";
import { rebasedOnto, type TheirReview, type VaultStates, vaultStates } from "./vault-state";
import type { PrInfo, SaverStatus } from "../shared/review-flow";
import { type ReviewKey, reviewKey } from "./review-key";
import { isAnotherAuthor } from "./review-owner";
import { isBlankUntitledContent, isLocalOnlyNew as checkLocalOnlyNew, repoLowerSet } from "./local-new";

const utf8Decoder = new TextDecoder("utf-8");

const EMPTY_REMOVALS: ReadonlyMap<string, string | null> = new Map();

const PRESENCE_RETRY_MS = 2_000;
const PRESENCE_RETRY_MOST_MS = 30_000;

const ASK_AT_ONCE = 4;
const DETAILS_PER_REQUEST = 50;
export const LOOK_BUDGET = 40;
export const STATUS_TTL_MS = 30_000;
export const DETAIL_TTL_MS = 10 * 60_000;
export const LEARN_GRACE_MS = CHANGE_GRACE_MS;
const FILL_IN_MS = 1_000;
export const RETRY_AFTER_FAILED_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000, 30_000];
const MIN_RATE_LIMIT_MS = 5_000;
const MAX_RATE_LIMIT_MS = 60 * 60_000;
const DEFAULT_RATE_LIMIT_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000, 900_000];
const RETRY_MS = 10_000;

interface Watched {
  path: string;
  review: ReviewStatus | null;
  read: boolean;
  version: number;
  learnedAt: number | null;
}

interface Lookups {
  rows: Map<string, ChangeRow>;
  groupById: Map<string, ChangeRow>;
  groupByPath: Map<string, ChangeRow>;
}

interface StatusRecord {
  key: string;
  at: number;
  review: ReviewStatus | null;
  light?: boolean;
  withoutSaver?: boolean;
  draftSig?: string;
  mainSha?: string;
}

interface VerifyTarget {
  change: LocalChange;
  known: StatusRecord;
  pr: PrInfo;
  fallback: ReviewStatus | null;
  fromStale: boolean;
  downgraded?: boolean;
}

function flightOf(groups: GroupsRead): { paths: NonNullable<GroupsRead["paths"]>; stale: boolean; overviews: ReadonlyMap<string, GroupOverview>; saves?: SavesTo; asOf?: number } | null {
  return groups.kind !== "unknown" && groups.kind !== "rate_limited" && groups.paths ? { paths: groups.paths, stale: groups.stale === true, overviews: new Map(groups.kind === "groups" ? Object.entries(groups.overviews) : []), ...(groups.saves ? { saves: groups.saves } : {}), ...(groups.asOf === undefined ? {} : { asOf: groups.asOf }) } : null;
}

const nameOf =(path: string) => path.split("/").pop() ?? path;

const uncheckedUntilSent = (change: LocalChange): boolean => change.kind === "new" || (change.kind === "edited" && change.baseUnknown);
const startsUnsent = (row: ChangeRow): boolean => row.entry === null && uncheckedUntilSent(row.change);

export function entryFor(change: LocalChange, review: ReviewStatus | null, openComments = 0): ChangeSetEntry | null {
  const pr = review?.pr;
  if (!pr || pr.state === "merged" || pr.state === "closed") return null;
  const isDraft = pr.isDraft || pr.state === "draft";
  const stage = reviewStage({ isDraft, mergeableState: pr.mergeableState, autoMergeEnabled: pr.autoMergeEnabled });
  return {
    path: change.path,
    kind: "note",
    name: nameOf(change.path),
    prNumber: pr.number,
    prUrl: pr.url,
    isDraft,
    authorLogin: pr.authorLogin ?? null,
    stage,
    block: null,
    next: isDraft ? "submit" : stage === "conflicts" ? null : "publish",
    existsOnBase: change.kind !== "new",
    requestedReviewers: pr.requestedReviewers ?? [],
    openComments,
  };
}

export function draftEntry(change: LocalChange, theirs?: TheirReview): ChangeSetEntry {
  return { path: change.path, kind: "note", name: nameOf(change.path), prNumber: 0, prUrl: "", isDraft: true, authorLogin: theirs?.by ?? null, stage: "in_progress", block: null, next: change.kind === "deleted" ? "publish" : "submit", existsOnBase: change.kind !== "new", requestedReviewers: [], openComments: 0 };
}

export class ChangesModel {
  private current: ChangesState = {
    phase: "loading",
    rows: [],
    set: { entries: [], dependencies: [], stage: null },
    sections: [],
    groupsOn: false,
    groupsLocked: false,
    groups: [],
    loose: [],
    units: { groups: [], loose: [] },
    selection: ALL_SELECTED,
    selected: [],
    published: [],
    busy: false,
    doing: null,
    missing: 0,
    hidden: 0,
    leftOut: NOTHING_LEFT_OUT,
    copying: null,
    aware: null,
    changedHere: [],
    progressRows: new Map(),
    line: null,
    choices: new Map(),
    heldDeletes: null,
    retryAfterMs: null,
    rateLimitedUntil: null,
  };
  private readonly awareness = new Awareness(() => this.now());
  private presenceRetry: number | null = null;
  private presenceFailures = 0;
  private theirs: ReadonlyMap<string, TheirReview> | undefined;
  private notHere: CopyInFile[] = [];
  private notHereSkipped: string[] = [];
  private commit: string | null = null;
  private otherFiles: string[] = [];
  private otherAttachments = new Map<string, string>();
  private readonly unsure = new Map<string, number>();
  private readonly notBase = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly overlay = new Map<string, { sha: string | null; before: string | null;  sent: string | null }>();
  private readonly statuses = new Map<string, StatusRecord>();
  private pending: PendingChange[] = [];
  private denied = false;
  catchUpOff(repo: string, hasReview: boolean): string | null {
    return writesOffWords(this.offline(), this.denied && hasReview, repo);
  }

  private quota: PublishQuota | null = null;
  private flight: { paths: NonNullable<GroupsRead["paths"]>; stale: boolean; overviews: ReadonlyMap<string, GroupOverview>; saves?: SavesTo; asOf?: number } | null = null;
  private draftsChecked = false;
  private levelAt: number | null = null;
  private attachmentShas: ReadonlyMap<string, string> | null = null;
  private readonly learnedAt = new Map<string, number>();
  private memory: SelectionMemory = freshSelectionMemory();
  private readonly fromCheckedGroup = new Map<string, LocalChangeKind>();
  private groupsRead: { on: boolean; locked: boolean; overviews: Record<string, GroupOverview> } = { on: false, locked: false, overviews: {} };
  private place: string | null = null;
  private watched: Watched | null = null;
  private timer: number | null = null;
  private readonly asking = new AskAgain();
  private readonly unreadAsking = new AskAgain();
  private disposed = false;
  private failedLooks = 0;
  private rateLimitedLooks = 0;
  private groupsLimitedUntil = 0;
  private detailsLimitedUntil = 0;
  private refreshing: Promise<void> | null = null;
  private again: { scheduled: boolean } | null = null;
  private readonly lookListeners = new Set<(looked: Looked | null) => void>();
  private readonly draftListeners = new Set<(prNumber: number, isDraft: boolean, requestedReviewers?: readonly string[]) => void>();
  private looked: { rows: ChangeRow[]; groups: ChangeRow[]; maps: Lookups } | null = null;
  private states: VaultStates | null = null;
  private repoFiles: ReadonlyMap<string, string> | null = null;
  private readonly closedDraftPaths = new Map<string, { branch: string | null; prNumber: number | null; at: number }>();

  constructor(private readonly deps: ChangesDeps) {}

  dispose(): void {
    this.disposed = true;
    this.watched = null;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.presenceRetry !== null) window.clearTimeout(this.presenceRetry);
    this.presenceRetry = null;
    this.listeners.clear();
    this.lookListeners.clear();
    this.draftListeners.clear();
  }

  private cancelLookTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private lookLater(ms: number): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.lookAgain(true);
    }, ms);
  }

  state(): ChangesState {
    return this.current;
  }

  onLooked(listener: (looked: Looked | null) => void): () => void {
    this.lookListeners.add(listener);
    return () => this.lookListeners.delete(listener);
  }

  onDraftMoved(listener: (prNumber: number, isDraft: boolean, requestedReviewers?: readonly string[]) => void): () => void {
    this.draftListeners.add(listener);
    return () => this.draftListeners.delete(listener);
  }

  private emitDraftMoved(prNumber: number, isDraft: boolean, requestedReviewers?: readonly string[]): void {
    this.draftListeners.forEach((listener) => listener(prNumber, isDraft, requestedReviewers));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private vaultOverviews(): Record<string, GroupOverview> | undefined {
    if (!this.groupsRead.on) return undefined;
    const vault = (path: string): string => this.deps.vaultPath?.(path) ?? path;
    const answer: InFlightResponse = { base: "", paths: {}, pathsKnown: false, groups: this.groupsRead.overviews };
    this.pending = stillPending(answer, this.pending, this.now());
    const shown = applyPending(answer, this.pending).groups ?? {};
    return Object.fromEntries(Object.entries(shown).map(([branch, one]) => [branch, { ...one, paths: one.paths.map(vault), holdPaths: one.holdPaths.map(vault) }]));
  }

  private groupRow(group: StatusGroup, byPath: ReadonlyMap<string, ChangeRow>): ChangeRow | null {
    const files = group.files.map((file) => ({ path: file.path, row: byPath.get(file.path) ?? null }));
    const members = files.flatMap((file) => (file.row ? [file.row] : []));
    const ask = members.find((row) => row.change.kind !== "deleted") ?? members[0];
    const path = group.overview.paths[0];
    const doc = ask?.doc ?? (path === undefined ? null : this.deps.documentFor(path));
    if (!doc || path === undefined) return null;
    const change = ask?.change ?? { kind: "edited" as const, path, sha: "", repoSha: null, mainMoved: false, baseUnknown: true, base: null };
    return { change, doc, review: ask?.review ?? null, entry: group.entry, unit: group.entry, group: { id: group.overview.id, overview: group.overview, held: group.held, files, members } };
  }

  private set(patch: Partial<ChangesState>): void {
    const next = { ...this.current, ...patch };
    const byPath = new Map(next.rows.map((row) => [row.change.path, row]));
    const allUnits = statusUnits(next.rows.map((row) => row.unit), this.vaultOverviews());
    const groups = allUnits.groups.flatMap((group) => this.groupRow(group, byPath) ?? []);
    const loose = allUnits.loose.flatMap((entry) => byPath.get(entry.path) ?? []);
    const viewer = this.deps.viewerLogin?.() ?? null;
    const aware = this.awareness.state({ viewer, flight: this.flight, vaultPath: (path) => this.deps.vaultPath?.(path) ?? path, documentFor: (path) => this.deps.documentFor(path) }, next.aware);
    const layout = awareLayout({ aware, loose, units: allUnits, line: next.line, live: (path) => this.deps.isLive?.(path) === true });
    const { units } = layout;
    this.settleLeftGroup(units.loose, byPath);
    this.memory = keepSelection(
      withSelection(this.memory, next.selection),
      selectionUnits(units, (entry) => {
        const row = byPath.get(entry.path);
        return row !== undefined && (row.change.kind === "deleted" || (startsUnsent(row) && !this.fromCheckedGroup.has(row.change.path)));
      }),
      viewer,
      Date.now(),
    );
    next.selection = this.memory.selection;
    const byKey = new Map([...loose, ...groups].map((row) => [unitKey(row.unit), row]));
    next.selected = selectableUnits(units)
      .filter((unit) => isSelected(next.selection, unitKey(unit)))
      .flatMap((unit) => byKey.get(unitKey(unit)) ?? []);
    next.set = { entries: next.rows.flatMap((row) => (row.entry ? [row.entry] : [])), dependencies: [], stage: null };
    const reviewed = reviewSections({ entries: loose.flatMap((row) => (row.entry ? [row.entry] : [])), dependencies: [], stage: null }, []).map(({ section, rows }) => ({ section, rows: rows.map(({ entry }) => byPath.get(entry.path)!) }));
    const unsent = loose.filter((row) => !row.entry);
    const published = next.published.filter((row) => !byPath.has(row.change.path));
    next.sections = [...(unsent.length ? [{ section: "changed" as const, rows: unsent }] : []), ...reviewed, ...(published.length ? [{ section: "published" as const, rows: published }] : [])];
    next.aware = aware;
    next.changedHere = layout.changedHere;
    next.progressRows = layout.progressRows;
    next.line = layout.line;
    next.groupsOn = this.groupsRead.on;
    next.groupsLocked = this.groupsRead.locked;
    next.groups = groups;
    next.loose = loose;
    next.units = units;
    this.current = next;
    this.listeners.forEach((listener) => listener());
  }

  private askPresence(): (() => Promise<PresenceRead>) | undefined {
    const { deps } = this;
    return deps.presence ? () => deps.presence!() : undefined;
  }

  async refreshPresence(again = false): Promise<void> {
    if (!this.deps.presence || this.disposed || !this.deps.signedIn()) return;
    if (again) this.awareness.forgetOff();
    const place = this.deps.place?.() ?? "";
    const read = await this.awareness.read(this.askPresence(), true);
    if (this.disposed || (this.deps.place?.() ?? "") !== place) return;
    if (read.kind === "unknown") return this.retryPresence();
    this.presenceFailures = 0;
    if (this.presenceRetry !== null) window.clearTimeout(this.presenceRetry);
    this.presenceRetry = null;
    if (this.awareness.heard(read)) this.set({});
  }

  private retryPresence(): void {
    if (this.disposed || this.presenceRetry !== null) return;
    const wait = Math.min(PRESENCE_RETRY_MS * 2 ** this.presenceFailures, PRESENCE_RETRY_MOST_MS);
    this.presenceFailures += 1;
    this.presenceRetry = window.setTimeout(() => {
      this.presenceRetry = null;
      void this.refreshPresence();
    }, wait);
  }

  private enterRateLimit(retryAfterMs?: number | null, patch: Partial<ChangesState> = {}, bucket?: "groups" | "details"): number {
    const fallback = DEFAULT_RATE_LIMIT_MS[Math.min(this.rateLimitedLooks, DEFAULT_RATE_LIMIT_MS.length - 1)] ?? 60_000;
    const wait = retryAfterMs != null ? Math.min(Math.max(retryAfterMs, MIN_RATE_LIMIT_MS), MAX_RATE_LIMIT_MS) : fallback;
    const now = this.now();
    const until = now + wait;
    if (bucket === "groups") this.groupsLimitedUntil = Math.max(this.groupsLimitedUntil, until);
    else if (bucket === "details") this.detailsLimitedUntil = Math.max(this.detailsLimitedUntil, until);
    const effectiveUntil = Math.max(
      until,
      bucket === "groups" ? this.groupsLimitedUntil : bucket === "details" ? this.detailsLimitedUntil : 0,
    );
    const effectiveWait = Math.max(wait, effectiveUntil - now);
    this.rateLimitedLooks += 1;
    this.cancelLookTimer();
    this.lookLater(effectiveWait);
    this.set({ ...patch, phase: "rate-limited", retryAfterMs: effectiveWait, rateLimitedUntil: effectiveUntil });
    return effectiveWait;
  }

  private async readGroups(): Promise<GroupsRead> {
    if (!this.deps.groups) return { kind: "off" };
    const remaining = this.groupsLimitedUntil - this.now();
    if (remaining > 0) return { kind: "rate_limited", retryAfterMs: remaining };
    this.groupsLimitedUntil = 0;
    return this.deps.groups();
  }

  private readFlight(groups: GroupsRead): { paths: NonNullable<GroupsRead["paths"]>; stale: boolean; overviews: ReadonlyMap<string, GroupOverview>; saves?: SavesTo; asOf?: number } | null {
    const raw = flightOf(groups);
    if (!raw || this.closedDraftPaths.size === 0) return raw;
    const now = this.now();
    let nextPaths: NonNullable<GroupsRead["paths"]> | null = null;
    for (const [repoPath, closed] of [...this.closedDraftPaths]) {
      if (now - closed.at >= LEARN_GRACE_MS) {
        this.closedDraftPaths.delete(repoPath);
        continue;
      }
      const entries = raw.paths[repoPath];
      if (!entries) {
        if (!raw.stale) this.closedDraftPaths.delete(repoPath);
        continue;
      }
      const matchesClosed = (one: NonNullable<GroupsRead["paths"]>[string][number]): boolean =>
        (closed.branch !== null && one.branch === closed.branch) ||
        (closed.prNumber !== null && one.prNumber === closed.prNumber) ||
        (closed.branch === null && closed.prNumber === null);
      const filtered = entries.filter((one) => !matchesClosed(one));
      if (filtered.length === entries.length) {
        if (!raw.stale) this.closedDraftPaths.delete(repoPath);
        continue;
      }
      nextPaths ??= { ...raw.paths };
      if (filtered.length > 0) nextPaths[repoPath] = filtered;
      else delete nextPaths[repoPath];
    }
    return nextPaths ? { ...raw, paths: nextPaths } : raw;
  }

  async checkNow(about: { added?: number } = {}): Promise<void> {
    if (this.disposed || !this.deps.signedIn() || this.awareness.asleep()) return;
    if (this.current.phase === "rate-limited" && this.now() < (this.current.rateLimitedUntil ?? 0)) return;
    const place = this.deps.place?.() ?? "";
    const [groups, presence] = await Promise.all([this.readGroups(), this.awareness.read(this.askPresence())]);
    if (this.disposed || (this.deps.place?.() ?? "") !== place) return;
    this.awareness.heard(presence);
    if (groups.kind === "rate_limited") {
      this.enterRateLimit(groups.retryAfterMs, {}, "groups");
      return;
    }
    const flight = this.readFlight(groups);
    if (flight) {
      this.flight = flight;
      this.draftsChecked = true;
    }
    if (!flight || !this.awareness.hasFiles()) return;
    const viewer = this.deps.viewerLogin?.() ?? null;
    const aware = this.awareness.state({ viewer, flight, vaultPath: (path) => this.deps.vaultPath?.(path) ?? path, documentFor: (path) => this.deps.documentFor(path) }, this.current.aware);
    if (aware === null) return this.set({ line: null });
    if (about.added !== undefined && about.added > 0) this.set({ line: { added: about.added } });
  }

  offerChoice(path: string, choice: NoteChoice | null): void {
    const next = withChoice(this.current.choices, path, choice);
    if (next !== null) this.set({ choices: next });
  }

  holdDeletes(offer: HeldDeletes | null): void {
    this.set({ heldDeletes: offer });
  }

  private readonly told = new Map<string, Map<string, readonly string[]>>();

  attachmentTold(path: string, words: readonly string[], source: "send" | "bring" = "send"): void {
    const sources = this.told.get(path) ?? new Map<string, readonly string[]>();
    if ((sources.get(source) ?? []).join("\n") === words.join("\n")) return;
    if (words.length === 0) sources.delete(source);
    else sources.set(source, words);
    if (sources.size === 0) this.told.delete(path);
    else this.told.set(path, sources);
    this.redraw();
  }

  private toldOf(path: string): string[] {
    return [...new Set([...(this.told.get(path)?.values() ?? [])].flat())];
  }

  redraw(): void {
    this.listeners.forEach((listener) => listener());
  }

  closeLine(): void {
    if (this.current.line !== null) this.set({ line: null });
    else this.set({});
  }

  private readonly learned = new Set<string>();

  setBusy(busy: false): void;
  setBusy(busy: true, doing: NonNullable<ChangesState["doing"]>): void;
  setBusy(busy: boolean, doing: ChangesState["doing"] = null): void {
    if (!busy) {
      for (const [path, known] of this.statuses) if (!this.learned.has(path)) known.at = 0;
      this.learned.clear();
    }
    this.set({ busy, doing: busy ? doing : null });
    if (!busy && this.watched && !this.watched.read) void this.readWatched(true);
  }

  learn(path: string, review: ReviewStatus): void {
    const pr = review.pr;
    if (pr && pr.number > 0 && (pr.state === "open" || pr.state === "draft")) {
      this.emitDraftMoved(pr.number, pr.isDraft || pr.state === "draft", pr.requestedReviewers);
    }
    const row = this.row(path);
    if (!row) {
      const watched = this.watched;
      if (watched?.path === path) {
        watched.review = review;
        watched.read = true;
        watched.version++;
        watched.learnedAt = this.now();
        this.listeners.forEach((listener) => listener());
      }
      return;
    }
    const draftSig = this.draftSigOf(path, review.reviewBranch);
    this.statuses.set(path, { key: this.keyOf(row.change), at: this.now(), review, mainSha: row.change.repoSha ?? "", ...(draftSig === undefined ? {} : { draftSig }) });
    this.learnedAt.set(path, this.now());
    this.learned.add(path);
    const next = this.rowOf(row.change);
    if (next) this.set({ rows: this.current.rows.map((one) => (one.change.path === path ? next : one)) });
  }

  change(change: InFlightChange): void {
    const replaced = (one: PendingChange): boolean => change.kind === "draft" && one.change.kind === "draft" && one.change.groupIds.some((id) => change.groupIds.includes(id));
    this.pending = [...this.pending.filter((one) => !replaced(one)), { change, madeAt: this.now() }];
    if (change.kind === "draft") {
      for (const id of change.groupIds) {
        const prNumber = this.group(id)?.group?.overview.prNumber ?? Object.values(this.groupsRead.overviews).find((one) => one.id === id)?.prNumber;
        if (prNumber && prNumber > 0) this.emitDraftMoved(prNumber, change.isDraft);
      }
      for (const path of change.paths) {
        const prNumber = this.row(path)?.entry?.prNumber;
        if (prNumber && prNumber > 0) this.emitDraftMoved(prNumber, change.isDraft);
      }
    }
    this.set({});
  }

  select(key: string, on: boolean): void {
    this.selectMany([key], on);
  }

  selectMany(keys: readonly string[], on: boolean): void {
    this.set({ selection: selectKeys(this.current.selection, keys, on) });
  }

  isSelected(key: string): boolean {
    return isSelected(this.current.selection, key);
  }

  selectAll(on: boolean): void {
    this.set({ selection: selectAllKeys(on) });
  }

  selectOnly(path: string): void {
    this.set({ selection: selectOnlyKey(path) });
  }

  leftGroup(paths: readonly string[], groupWasChecked: boolean): void {
    if (!groupWasChecked) return;
    for (const path of paths) {
      const row = this.row(path);
      if (row) this.fromCheckedGroup.set(path, row.change.kind);
    }
    this.set({ selection: selectKeys(this.current.selection, paths, true) });
  }

  private settleLeftGroup(loose: readonly ChangeSetEntry[], byPath: ReadonlyMap<string, ChangeRow>): void {
    if (this.fromCheckedGroup.size === 0) return;
    const shown = new Map(loose.map((entry) => [entry.path, entry]));
    const offered = new Set(this.memory.offered);
    for (const [path, kind] of [...this.fromCheckedGroup]) {
      const row = byPath.get(path);
      const entry = shown.get(path);
      const still = row !== undefined && row.change.kind === kind && uncheckedUntilSent(row.change);
      if (still && entry === undefined) continue;
      if (still && entry !== undefined && row.entry === null) offered.add(unitKey(entry));
      this.fromCheckedGroup.delete(path);
    }
    this.memory = { ...this.memory, offered };
  }

  arrive(key: string): void {
    this.memory = expectArrival(this.memory, key);
    this.set({ selection: selectKeys(this.current.selection, [key], true) });
  }

  joined(keys: readonly string[]): void {
    this.memory = forgetJoined(withSelection(this.memory, this.current.selection), keys);
    this.set({ selection: this.memory.selection });
  }

  private lookups(): Lookups {
    const { rows, groups } = this.current;
    if (this.looked?.rows === rows && this.looked.groups === groups) return this.looked.maps;
    const maps = { rows: new Map<string, ChangeRow>(), groupById: new Map<string, ChangeRow>(), groupByPath: new Map<string, ChangeRow>() };
    for (const row of rows) if (!maps.rows.has(row.change.path)) maps.rows.set(row.change.path, row);
    for (const group of groups) {
      if (!maps.groupById.has(group.group!.id)) maps.groupById.set(group.group!.id, group);
      for (const file of group.group!.files) if (!maps.groupByPath.has(file.path)) maps.groupByPath.set(file.path, group);
    }
    this.looked = { rows, groups, maps };
    return maps;
  }

  group(id: string): ChangeRow | undefined {
    return this.lookups().groupById.get(id);
  }

  groupOf(path: string): ChangeRow | undefined {
    return this.lookups().groupByPath.get(path);
  }

  remember(rows: readonly ChangeRow[]): void {
    for (const row of rows) {
      this.overlay.set(row.change.path, { sha: row.change.kind === "deleted" ? null : row.change.sha, before: row.change.repoSha, sent: this.deps.cache.get(row.change.path)?.sent ?? null });
      if (row.change.from) {
        const fromBefore = this.repoFiles?.get(row.change.from) ?? this.deps.cache.deleted().find((gone) => gone.path === row.change.from)?.sha ?? row.change.sha;
        this.overlay.set(row.change.from, { sha: null, before: fromBefore, sent: null });
      }
    }
    const paths = new Set(rows.map((row) => row.change.path));
    this.set({ published: [...this.current.published.filter((row) => !paths.has(row.change.path)), ...rows.map((row) => ({ ...row, entry: null, review: null, unit: row.unit }))] });
  }

  expireReviews(only?: { branches: ReadonlySet<string>; prs: ReadonlySet<number> }): void {
    for (const known of this.statuses.values()) {
      if (only === undefined || (known.review?.reviewBranch != null && only.branches.has(known.review.reviewBranch)) || (known.review?.pr != null && only.prs.has(known.review.pr.number))) known.at = 0;
    }
  }

  refresh(): Promise<void> {
    return this.lookAgain(false);
  }

  private lookAgain(scheduled: boolean): Promise<void> {
    if (this.refreshing) {
      this.again = { scheduled: scheduled && (this.again?.scheduled ?? true) };
      return this.refreshing;
    }
    this.refreshing = this.look(scheduled).finally(() => {
      this.refreshing = null;
      const next = this.again;
      this.again = null;
      if (next) void this.lookAgain(next.scheduled);
    });
    return this.refreshing;
  }

  private async look(scheduled: boolean): Promise<void> {
    const place = this.deps.place?.() ?? "";
    if (this.disposed) return;
    if (!scheduled) {
      this.asking.reset();
      this.unreadAsking.reset();
    }
    if (this.place !== null && this.place !== place) {
      this.overlay.clear();
      this.statuses.clear();
      this.learnedAt.clear();
      this.closedDraftPaths.clear();
      this.flight = null;
      this.draftsChecked = false;
      this.levelAt = null;
      this.denied = false;
      this.quota = null;
      this.pending = [];
      this.memory = freshSelectionMemory();
      this.fromCheckedGroup.clear();
      this.groupsRead = { on: false, locked: false, overviews: {} };
      this.notHere = [];
      this.notHereSkipped = [];
      this.states = null;
      this.repoFiles = null;
      this.theirs = undefined;
      this.awareness.reset();
      this.watched = null;
      this.commit = null;
      this.otherFiles = [];
      this.otherAttachments = new Map();
      this.rateLimitedLooks = 0;
      this.groupsLimitedUntil = 0;
      this.detailsLimitedUntil = 0;
      this.set({ rows: [], published: [], selection: ALL_SELECTED, phase: "loading", missing: 0, hidden: 0, leftOut: NOTHING_LEFT_OUT, line: null, aware: null, changedHere: [], progressRows: new Map(), choices: new Map(), heldDeletes: null, retryAfterMs: null, rateLimitedUntil: null });
    }
    this.place = place;
    if (!this.deps.signedIn()) {
      this.draftsChecked = false;
      this.rateLimitedLooks = 0;
      this.groupsLimitedUntil = 0;
      this.detailsLimitedUntil = 0;
      this.lookListeners.forEach((listener) => listener(null));
      this.states = null;
      this.repoFiles = null;
      return this.set({ phase: "signed-out", rows: [], retryAfterMs: null, rateLimitedUntil: null });
    }
    if (scheduled && this.current.phase === "rate-limited") {
      const until = this.current.rateLimitedUntil ?? 0;
      if (this.now() < until) {
        this.lookLater(until - this.now());
        return;
      }
    }
    const everyFile = this.deps.listFiles();
    const listed = everyFile.filter((file) => this.deps.documentFor(file.path) !== null);
    if (this.current.phase !== "ready" && this.current.phase !== "offline" && this.current.phase !== "rate-limited") this.set({ phase: "loading" });
    const [scanned, repo, groups, presence] = await Promise.all([
      this.deps.cache.scan(listed, (path) => this.deps.readBytes(path)),
      this.deps.mirror.read(),
      this.readGroups(),
      this.awareness.read(this.askPresence()),
      this.deps.refreshIgnore?.(),
    ]);
    if (this.movedFrom(place)) return;
    this.awareness.heard(presence);
    if (presence.kind === "unknown" && this.deps.presence) this.retryPresence();
    this.awareness.scanned(scanned.files);
    if (groups.kind !== "unknown" && groups.kind !== "rate_limited") {
      this.denied = groups.canPush === false;
      this.quota = groups.publishQuota ?? null;
    }
    if (groups.kind !== "rate_limited") {
      this.flight = this.readFlight(groups);
      this.draftsChecked = groups.kind !== "unknown";
      if (this.flight && (!this.flight.stale || this.levelAt === null)) this.levelAt = this.now();
      if (groups.kind !== "unknown") {
        this.groupsRead = groups.kind === "groups" ? { on: true, locked: groups.locked, overviews: groups.overviews } : { on: false, locked: false, overviews: {} };
        this.memory = settleArrivals(withSelection(this.memory, this.current.selection));
        this.current = { ...this.current, selection: this.memory.selection };
      }
    }
    if (repo.kind === "building") {
      this.lookLater(3_000);
      return;
    }
    if (repo.kind === "not_installed") {
      this.repoFiles = null;
      this.rateLimitedLooks = 0;
      this.lookListeners.forEach((listener) => listener(null));
      return this.set({ phase: "not-installed", retryAfterMs: null, rateLimitedUntil: null });
    }
    if (repo.kind === "rate_limited") {
      this.repoFiles = null;
      this.lookListeners.forEach((listener) => listener(null));
      const waitHint = groups.kind === "rate_limited" ? Math.max(repo.retryAfterMs ?? 0, groups.retryAfterMs ?? 0) || null : repo.retryAfterMs;
      this.enterRateLimit(waitHint, {}, groups.kind === "rate_limited" ? "groups" : undefined);
      return;
    }
    if (repo.kind !== "files") {
      this.repoFiles = null;
      this.rateLimitedLooks = 0;
      this.lookListeners.forEach((listener) => listener(null));
      const retry = RETRY_AFTER_FAILED_MS[Math.min(this.failedLooks, RETRY_AFTER_FAILED_MS.length - 1)] ?? 0;
      this.failedLooks += 1;
      this.lookLater(retry);
      return this.set({ phase: "offline", retryAfterMs: null, rateLimitedUntil: null });
    }
    this.failedLooks = 0;
    if (groups.kind === "rate_limited") {
      this.lookListeners.forEach((listener) => listener(null));
      this.enterRateLimit(groups.retryAfterMs, {}, "groups");
      return;
    }
    const hidden = [...repo.files.keys()].filter((path) => LISTED_FILE.test(path) && isHiddenPath(path)).length;
    const inVault = new Set(everyFile.map((file) => file.path.toLowerCase()));
    const others = [...repo.files.keys()].filter((path) => isLeftOutKind(path) && !inVault.has(path.toLowerCase()));
    this.deps.mirror.settle?.(inVault);
    this.commit = repo.headSha;
    this.otherFiles = others;
    this.attachmentShas = new Map([...repo.files].filter(([path]) => isAttachmentPath(path)));
    this.otherAttachments = new Map(others.flatMap((path) => (isAttachmentPath(path) ? [[path, this.deps.mirror.repoPath(path)] as const] : [])));
    const repoFiles = new Map([...repo.files].filter(([path]) => LISTED_FILE.test(path) && !isHiddenPath(path)));
    for (const [path, { sha, before, sent }] of this.overlay) {
      const actual = repoFiles.get(path) ?? null;
      this.learnOwnPublish(path, sha, sent, actual);
      if (actual === sha || actual !== before) this.overlay.delete(path);
      else if (sha === null) repoFiles.delete(path);
      else repoFiles.set(path, sha);
    }
    let unread = 0;
    if (this.deps.sameAsRepo) {
      unread = await settleSameness({ files: scanned.files, repo: repoFiles, cache: this.deps.cache, ask: this.deps.sameAsRepo, prefetch: this.deps.prefetchBlobs, documentFor: (path) => this.deps.documentFor(path), unsure: this.unsure, notBase: this.notBase, now: () => this.now(), alive: () => !this.disposed && (this.deps.place?.() ?? "") === place });
      if (this.movedFrom(place)) return;
    }
    const cache = this.deps.cache;
    const drafts = this.draftsLooked().drafts;
    const draftsKnown = drafts !== undefined ? drafts.level : this.deps.groups === undefined;
    cache.reconcile(repoFiles, new Set(drafts?.byPath.keys()), draftsKnown);
    cache.clearForeign([...cache.foreignFiles()].filter(([path, sha]) => scanned.files.get(path)?.sha !== sha).map(([path]) => path));
    cache.save();
    const theirs = this.theirReviews();
    if (theirs) this.theirs = theirs;
    const login = this.deps.viewerLogin?.() ?? "";
    const renamed = new Map<string, string>();
    if (drafts) {
      for (const [to, draft] of drafts.byPath) {
        if (!draft.removes) continue;
        const entry = scanned.files.get(to);
        if (!entry) continue;
        const key = draftKey(draft);
        const matchingEntry = entry.sentTo !== undefined && key !== null && entry.sentTo !== key ? undefined : entry;
        const related =
          login === "" ||
          hasOwnOrAgreedDraft(matchingEntry, draft, login) ||
          sameLogin(draftWriter(draft), login) ||
          (draft.blob !== null && entry.sha === draft.blob);
        if (!related) continue;
        for (const [from, target] of draft.removes) {
          if (target === to) {
            renamed.set(to, from);
            break;
          }
        }
      }
    }
    const isIgnored = this.deps.isIgnored;
    const leftOut = isIgnored ? (path: string): boolean => !repoFiles.has(path) && (scanned.files.get(path)?.base ?? null) === null && isIgnored(path) : undefined;
    const states = vaultStates({ files: scanned.files, repo: repoFiles, added: repo.added, deleted: cache.deleted(), foreign: cache.foreignFiles(), keptFromMain: (path) => this.deps.deletedOnMain?.(path) === true, theirs, ...(leftOut ? { leftOut } : {}), ...(renamed.size > 0 ? { renamed } : {}) });
    this.notHere = states.missing.copy.flatMap((path) => {
      const doc = this.deps.documentFor(path);
      return doc ? [{ path, doc, sha: repoFiles.get(path) ?? null }] : [];
    });
    this.notHereSkipped = states.missing.skipped;
    const blankUntitled = new Set<string>();
    for (const [path, entry] of scanned.files) {
      if (entry.base !== null || entry.sent !== undefined || repoFiles.has(path) || this.deps.deletedOnMain?.(path) === true) continue;
      if (!isBlankUntitledContent(path, entry.size)) continue;
      if (entry.size === 0) {
        blankUntitled.add(path);
        continue;
      }
      const rawBytes = await this.deps.readBytes(path).catch(() => null);
      if (rawBytes !== null && isBlankUntitledContent(path, utf8Decoder.decode(rawBytes))) blankUntitled.add(path);
    }
    if (this.movedFrom(place)) return;
    const plannedChanges = blankUntitled.size > 0 ? localChanges(states).filter((change) => !blankUntitled.has(change.path)) : localChanges(states);
    const { rows, limited } = await this.rowsFor(plannedChanges);
    if (this.movedFrom(place)) return;
    this.states = states;
    this.repoFiles = repoFiles;
    if (limited !== null) {
      this.lookListeners.forEach((listener) => listener(null));
      this.enterRateLimit(limited.retryAfterMs, { rows, missing: this.notHere.length, hidden, leftOut: leftOutKinds(others) }, "details");
      return;
    }
    this.rateLimitedLooks = 0;
    this.set({ phase: "ready", rows, missing: this.notHere.length, hidden, leftOut: leftOutKinds(others), retryAfterMs: null, rateLimitedUntil: null });
    if (unread > 0) {
      const again = this.unreadAsking.after({ unread: true });
      if (again !== null) this.lookLater(again);
    } else this.unreadAsking.reset();
    const looked: Looked = { files: scanned.files, repo: repoFiles, deleted: this.deps.cache.deleted(), rows, ...(drafts ? { drafts } : {}) };
    this.lookListeners.forEach((listener) => listener(looked));
    void this.readWatched();
  }

  private learnOwnPublish(path: string, published: string | null, sent: string | null, actual: string | null): void {
    if (published !== null && sent !== null && actual === sent && actual !== published) this.deps.cache.sameAs(path, published, actual, "server");
  }

  private theirReviews(): Map<string, TheirReview> | undefined {
    const flight = this.flight;
    return flight ? teammateReviews(flight.paths, this.deps.viewerLogin?.() ?? null, flight.overviews, flight.saves, (path) => this.deps.vaultPath?.(path) ?? path) : undefined;
  }

  vaultPathFor(path: string): string {
    return this.deps.vaultPath?.(path) ?? path;
  }

  private draftsLooked(): Pick<Looked, "drafts"> {
    const flight = this.flight;
    if (!flight) return {};
    const login = this.deps.viewerLogin?.() ?? null;
    const byPath = new Map<string, Draft>();
    const vaultPath = (path: string): string => this.deps.vaultPath?.(path) ?? path;
    const removals = removalsByBranch(flight.paths, vaultPath);
    for (const path in flight.paths) {
      const here = vaultPath(path);
      if (this.isSupersededDraftSource(here)) continue;
      const draft = draftOf(flight.paths[path], login, flight.overviews, flight.saves);
      if (!draft) continue;
      draft.removes = removals.size > 0 ? (removals.get(draft.branch) ?? EMPTY_REMOVALS) : EMPTY_REMOVALS;
      byPath.set(here, draft);
    }
    return { drafts: { byPath, level: !flight.stale, ...(flight.asOf === undefined ? {} : { asOf: flight.asOf }) } };
  }

  draftFor(path: string): Draft | undefined {
    return this.draftsLooked().drafts?.byPath.get(path);
  }

  draftsKnown(): boolean {
    return this.place !== null && this.place === (this.deps.place?.() ?? "") && this.current.phase === "ready" && this.draftsChecked;
  }

  draftInfo(path: string): { draft: Draft | null; sent: string | undefined; sentTo: string | undefined; holdsDraft: boolean } {
    if (this.place === null || this.place !== (this.deps.place?.() ?? "")) return { draft: null, sent: undefined, sentTo: undefined, holdsDraft: false };
    const flight = this.flight;
    const doc = this.deps.documentFor(path);
    const entries = flight && doc ? flight.paths[doc.path] : undefined;
    const draft = flight && entries ? draftOf(entries, this.deps.viewerLogin?.() ?? null, flight.overviews, flight.saves) : null;
    const entry = this.deps.cache.get(path);
    const holdsDraft = draft !== null && draft.blob !== null && entry !== undefined && (entry.sha === draft.blob || (entry.sent === draft.blob && agreedOf(entry) === entry.sha));
    return { draft, sent: entry?.sent, sentTo: entry?.sentTo, holdsDraft };
  }

  theirReview(path: string): TheirReview | undefined {
    return this.theirs?.get(path);
  }

  async draftAuthor(path: string, again = 1_500): Promise<string | null> {
    const viewer = this.deps.viewerLogin?.() ?? null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await this.readGroups();
      if (read.kind === "rate_limited") return null;
      if (read.kind !== "unknown" && read.paths) {
        const overviews = new Map(read.kind === "groups" ? Object.entries(read.overviews) : []);
        const by = teammateReviews(read.paths, viewer, overviews, read.saves, (file) => this.deps.vaultPath?.(file) ?? file).get(path)?.by ?? null;
        if (by !== null || read.stale !== true) return by;
      }
      if (attempt === 0) await new Promise((done) => window.setTimeout(done, again));
    }
    return null;
  }

  looking(): boolean {
    return this.refreshing !== null;
  }

  vault(): VaultStates | null {
    return this.states;
  }

  isLocalOnlyNew(path: string): boolean {
    return checkLocalOnlyNew({
      path,
      place: this.place,
      currentPlace: this.deps.place?.() ?? "",
      phase: this.current.phase,
      states: this.states,
      repoFiles: this.repoFiles,
      flight: this.flight,
      overlay: this.overlay,
      cache: this.deps.cache,
      documentFor: (one) => this.deps.documentFor(one),
      ...(this.deps.deletedOnMain ? { deletedOnMain: (one: string) => this.deps.deletedOnMain?.(one) === true } : {}),
      vaultPathFor: (repoPath) => this.vaultPathFor(repoPath),
    });
  }

  isOwnWrite(path: string): boolean {
    return this.deps.cache.isCopied(path);
  }

  hasRepoFile(path: string): boolean {
    const lower = path.toLowerCase();
    if (this.repoFiles !== null && repoLowerSet(this.repoFiles).has(lower)) return true;
    for (const [overPath, over] of this.overlay) if (overPath.toLowerCase() === lower && over.sha !== null) return true;
    return (this.deps.cache.get(path)?.base ?? null) !== null;
  }

  hasForeignDraft(path: string): boolean {
    if (this.theirs?.has(path)) return true;
    if (this.deps.cache.foreignFiles().has(path)) return true;
    const doc = this.deps.documentFor(path);
    const entries = this.flight && doc ? this.flight.paths[doc.path] : undefined;
    if (!entries || entries.length === 0) return false;
    const viewer = this.deps.viewerLogin?.() ?? "";
    for (const one of entries) {
      if (!one.isReviewBranch || one.changedStatus === "removed") continue;
      const author = one.prAuthorLogin ?? one.authorLogin ?? null;
      if (viewer === "" ? author !== null : isAnotherAuthor(author, viewer)) return true;
    }
    return false;
  }

  hasUnagreedRemoteDraft(path: string): boolean {
    if (this.deps.cache.get(path)?.sent !== undefined) return false;
    const doc = this.deps.documentFor(path);
    const entries = this.flight && doc ? this.flight.paths[doc.path] : undefined;
    return entries !== undefined && entries.some((one) => one.isReviewBranch && one.changedStatus !== "removed");
  }

  canTypeWhileJoining(path: string, locallyCreated = false): boolean {
    if (this.place !== null && this.place !== (this.deps.place?.() ?? "")) return false;
    if (this.deps.documentFor(path) === null) return false;
    if (this.deps.deletedOnMain?.(path) === true) return false;
    if (this.hasRepoFile(path) || this.hasForeignDraft(path)) return false;
    if (locallyCreated || this.isLocalOnlyNew(path)) return true;
    const cached = this.deps.cache.get(path);
    if (cached === undefined || cached.base !== null || this.repoFiles === null) return false;
    return !this.hasUnagreedRemoteDraft(path);
  }

  draftRenamedFrom(newPath: string): string | null {
    return this.deps.cache.draftRenameSource(newPath);
  }

  pendingDraftRenames(): ReadonlyMap<string, string> {
    return this.deps.cache.draftRenameTargets();
  }

  private isNonSupersedableSource(path: string): boolean {
    if (this.hasRepoFile(path) || this.hasForeignDraft(path)) return true;
    const cached = this.deps.cache.get(path);
    if (cached?.sentTo?.startsWith("group:") === true) return true;
    if (this.groupOf(path) !== undefined) return true;
    for (const one of Object.values(this.groupsRead.overviews)) {
      const vaultPaths = one.paths.map((repoPath) => this.deps.vaultPath?.(repoPath) ?? repoPath);
      if (vaultPaths.includes(path)) return true;
    }
    const doc = this.deps.documentFor(path);
    const viewer = this.deps.viewerLogin?.() ?? "";
    const entries = this.flight && doc ? this.flight.paths[doc.path] : undefined;
    if (entries) {
      for (const one of entries) {
        if (!one.isReviewBranch || one.changedStatus === "removed") continue;
        const author = one.prAuthorLogin ?? one.authorLogin ?? null;
        if (one.prIsDraft === false || isGroupBranch(one.branch) || (viewer === "" ? author !== null : isAnotherAuthor(author, viewer))) {
          return true;
        }
      }
    }
    const knownReview = this.statuses.get(path)?.review;
    if (knownReview?.reviewBranch && isGroupBranch(knownReview.reviewBranch)) return true;
    const knownPr = knownReview?.pr ?? null;
    if (knownPr && knownPr.state !== "merged" && knownPr.state !== "closed") {
      if ((!knownPr.isDraft && knownPr.state !== "draft") || Boolean(knownPr.group)) return true;
      if (viewer === "" ? Boolean(knownPr.authorLogin) : isAnotherAuthor(knownPr.authorLogin ?? null, viewer)) return true;
    }
    return false;
  }

  isSupersededDraftSource(oldPath: string): boolean {
    if (!this.deps.cache.isSupersededDraftSource(oldPath)) return false;
    return !this.isNonSupersedableSource(oldPath);
  }

  noteLocalCreate(path: string): void {
    if (!this.deps.cache.isSupersededDraftSource(path)) return;
    this.deps.cache.clearDraftRenamesFrom(path);
    this.set({});
  }

  noteLocalRename(oldPath: string, newPath: string): void {
    if (oldPath === newPath || this.deps.documentFor(oldPath) === null || this.deps.documentFor(newPath) === null) return;
    if (this.isNonSupersedableSource(oldPath)) return;
    const cachedOld = this.deps.cache.get(oldPath);
    if (cachedOld && cachedOld.base !== null) return;
    const chained = this.deps.cache.draftRenameSource(oldPath);
    if (chained !== null && this.isNonSupersedableSource(chained)) return;
    const oldDoc = this.deps.documentFor(oldPath);
    const viewer = this.deps.viewerLogin?.() ?? "";
    const flightEntries = this.flight && oldDoc ? this.flight.paths[oldDoc.path] : undefined;
    const hasOwnFlightDraft =
      flightEntries?.some(
        (one) =>
          one.isReviewBranch &&
          one.changedStatus !== "removed" &&
          !isGroupBranch(one.branch) &&
          one.prIsDraft !== false &&
          (viewer === "" || !isAnotherAuthor(one.prAuthorLogin ?? one.authorLogin ?? null, viewer)),
      ) === true;
    const knownReview = this.statuses.get(oldPath)?.review;
    const knownPr = knownReview?.pr ?? null;
    const hasOwnKnownDraft =
      ((knownReview?.reviewBranch != null && !isGroupBranch(knownReview.reviewBranch)) || knownPr != null) &&
      knownPr?.state !== "merged" &&
      knownPr?.state !== "closed" &&
      knownPr?.isDraft !== false &&
      !knownPr?.group &&
      (viewer === "" || !isAnotherAuthor(knownPr?.authorLogin ?? null, viewer));
    const hasUnlistedOwnSent =
      cachedOld?.sent !== undefined &&
      !cachedOld.sentTo?.startsWith("group:") &&
      (flightEntries === undefined || flightEntries.length === 0) &&
      knownReview === undefined;
    if (chained === null && !hasOwnFlightDraft && !hasOwnKnownDraft && !hasUnlistedOwnSent) return;
    this.deps.cache.recordDraftRename(oldPath, newPath);
    this.statuses.delete(oldPath);
    this.learnedAt.delete(oldPath);
    const filtered = this.current.rows.filter((row) => row.change.path !== oldPath);
    this.set(filtered.length === this.current.rows.length ? {} : { rows: filtered });
  }

  forgetDraftRename(newPath: string): void {
    if (this.deps.cache.forgetDraftRename(newPath)) this.set({});
  }

  clearInFlightPath(path: string, branch: string | null = null, prNumber: number | null = null): void {
    const repoPath = this.deps.documentFor(path)?.path ?? path;
    this.closedDraftPaths.set(repoPath, { branch, prNumber, at: this.now() });
    this.statuses.delete(path);
    this.learnedAt.delete(path);
    if (this.flight && repoPath in this.flight.paths) {
      const nextPaths = { ...this.flight.paths };
      const kept = (nextPaths[repoPath] ?? []).filter(
        (one) =>
          !(
            (branch !== null && one.branch === branch) ||
            (prNumber !== null && one.prNumber === prNumber) ||
            (branch === null && prNumber === null)
          ),
      );
      if (kept.length > 0) nextPaths[repoPath] = kept;
      else delete nextPaths[repoPath];
      this.flight = { ...this.flight, paths: nextPaths };
    }
    this.set({});
  }

  missingFiles(): readonly CopyInFile[] {
    return this.notHere;
  }

  copyOptions(): CopyInOptions {
    return { commit: this.commit, others: this.otherFiles, attachments: this.otherAttachments };
  }

  checkpoint(): void {
    this.deps.cache.flush();
  }

  copiedFrom(path: string, sha: string): void {
    this.deps.cache.copiedFrom(path, sha);
  }

  copying(progress: { done: number; total: number } | null): void {
    this.current = { ...this.current, copying: progress };
    this.listeners.forEach((listener) => listener());
  }

  missingSkipped(): readonly string[] {
    return this.notHereSkipped;
  }

  private movedFrom(place: string): boolean {
    if (this.disposed) return true;
    if ((this.deps.place?.() ?? "") === place) return false;
    this.again = { scheduled: false };
    return true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private keyOf(change: LocalChange): string {
    return `${change.kind}|${change.sha}|${change.repoSha ?? ""}`;
  }

  private draftSigOf(path: string, branch: string | null | undefined): string | undefined {
    if (!this.flight || !branch) return undefined;
    const repoPath = this.deps.documentFor(path)?.path ?? path;
    const entry = this.flight.paths[repoPath]?.find((one) => one.branch === branch);
    return entry ? `${entry.docBlobSha ?? ""}\0${entry.lastCommitAt ?? ""}` : undefined;
  }

  private fresh(change: LocalChange): boolean {
    const known = this.statuses.get(change.path);
    return known !== undefined && known.light !== true && known.key === this.keyOf(change) && this.now() - known.at < STATUS_TTL_MS;
  }

  isLearned(path: string): boolean {
    const now = this.now();
    const at = this.learnedAt.get(path);
    if (at !== undefined && now - at < LEARN_GRACE_MS) return true;
    return this.watched?.path === path && this.watched.learnedAt !== null && now - this.watched.learnedAt < LEARN_GRACE_MS;
  }

  private isStaleDraftDowngrade(path: string, incoming: PrInfo | null | undefined): boolean {
    const learned = this.learnedAt.get(path);
    if (learned === undefined || this.now() - learned >= LEARN_GRACE_MS) return false;
    const current = this.statuses.get(path)?.review?.pr ?? null;
    if (!current || current.state === "merged" || current.state === "closed" || current.isDraft || current.state === "draft") return false;
    if (!incoming || incoming.state === "merged" || incoming.state === "closed") return false;
    return incoming.number === current.number && (incoming.isDraft || incoming.state === "draft");
  }

  private async ask(changes: readonly LocalChange[], mode: "look" | "step" = "look"): Promise<{ failedReads: Set<string>; limited: { retryAfterMs?: number } | null }> {
    const failedReads = new Set<string>();
    let limited: { retryAfterMs?: number } | null = null;
    const place = this.deps.place?.() ?? "";
    const active = this.deps.activePath?.() ?? null;
    const numbered = this.deps.review.details
      ? changes.flatMap((change) => {
          const known = this.statuses.get(change.path);
          const light = known?.review?.pr;
          const doc = this.deps.documentFor(change.path);
          if (!known || !light || !doc || light.group) return [];
          if (change.path === active || known.review?.saver?.state === "waiting") return [];
          return [{ change, known, light, repo: doc.repo }];
        })
      : [];
    const given = new Set<string>();
    const remaining = this.detailsLimitedUntil - this.now();
    if (remaining > 0 && numbered.length > 0) {
      limited = { retryAfterMs: remaining };
      if (mode === "look") for (const { change } of numbered) given.add(change.path);
    } else if (numbered.length > 0) {
      this.detailsLimitedUntil = 0;
      for (const at of [...numbered.keys()].filter((i) => i % DETAILS_PER_REQUEST === 0)) {
        const run = numbered.slice(at, at + DETAILS_PER_REQUEST);
        const details = await this.deps.review.details!(run[0]!.repo, run.map((one) => one.light.number));
        if ((this.deps.place?.() ?? "") !== place || this.disposed) return { failedReads, limited };
        if (details === null) break;
        if (!(details instanceof Map)) {
          if (typeof details === "object" && "limited" in details && details.limited) {
            limited = details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs };
          }
          if (mode === "look") for (const { change } of numbered) given.add(change.path);
          break;
        }
        for (const { change, known, light } of run) {
          const detail = details.get(light.number);
          if (!detail) continue;
          const pr: PrInfo = { ...detail, url: light.url || detail.url, authorLogin: light.authorLogin ?? detail.authorLogin ?? null, ...(light.group ? { group: light.group } : {}) };
          if (this.isStaleDraftDowngrade(change.path, pr)) {
            const current = this.statuses.get(change.path);
            if (current) this.statuses.set(change.path, { ...current, key: this.keyOf(change) });
            given.add(change.path);
            continue;
          }
          const draftSig = this.draftSigOf(change.path, known.review?.reviewBranch);
          this.statuses.set(change.path, { key: this.keyOf(change), at: this.now(), review: { reviewBranch: known.review?.reviewBranch ?? null, pr }, withoutSaver: true, mainSha: change.repoSha ?? "", ...(draftSig === undefined ? {} : { draftSig }) });
          given.add(change.path);
        }
      }
    }
    if (limited !== null && mode === "look") return { failedReads, limited };
    changes = changes.filter((change) => !given.has(change.path));
    let next = 0;
    let halted = false;
    const worker = async (): Promise<void> => {
      for (let at = next++; at < changes.length; at = next++) {
        const change = changes[at]!;
        const doc = this.deps.documentFor(change.path);
        if (!doc) continue;
        if (halted) {
          failedReads.add(change.path);
          continue;
        }
        const review = await this.deps.review.status(doc);
        if ((this.deps.place?.() ?? "") !== place || this.disposed) return;
        if (review === null) {
          failedReads.add(change.path);
          if (mode === "step") halted = true;
          continue;
        }
        if (this.isStaleDraftDowngrade(change.path, review.pr)) {
          const current = this.statuses.get(change.path);
          if (current) {
            this.statuses.set(change.path, {
              ...current,
              key: this.keyOf(change),
              review: current.review ? { ...current.review, ...(review.saver ? { saver: review.saver } : {}) } : current.review,
            });
          }
          continue;
        }
        const draftSig = this.draftSigOf(change.path, review.reviewBranch);
        this.statuses.set(change.path, { key: this.keyOf(change), at: this.now(), review, mainSha: change.repoSha ?? "", ...(draftSig === undefined ? {} : { draftSig }) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(ASK_AT_ONCE, changes.length) }, worker));
    return { failedReads, limited };
  }

  private syncGroupDraft(pr: PrInfo | null | undefined): void {
    if (!pr || pr.number <= 0 || !this.groupsRead.on) return;
    const isDraft = pr.isDraft || pr.state === "draft";
    let changed = false;
    const next: Record<string, GroupOverview> = {};
    for (const [branch, one] of Object.entries(this.groupsRead.overviews)) {
      if (one.prNumber === pr.number && one.isDraft !== isDraft) {
        next[branch] = { ...one, isDraft };
        changed = true;
      } else {
        next[branch] = one;
      }
    }
    if (changed) this.groupsRead = { ...this.groupsRead, overviews: next };
  }

  private async verifyReviews(targets: readonly VerifyTarget[]): Promise<{ retryAfterMs?: number } | null> {
    if (targets.length === 0) return null;
    const place = this.deps.place?.() ?? "";
    const remaining = this.detailsLimitedUntil - this.now();
    if (remaining > 0) return { retryAfterMs: remaining };
    this.detailsLimitedUntil = 0;
    const needsStatus = (target: VerifyTarget): boolean => target.fromStale || target.downgraded === true;
    const learnedBefore = new Map(targets.map((target) => [target.change.path, this.learnedAt.get(target.change.path)]));
    const superseded = (path: string): boolean => this.learnedAt.get(path) !== learnedBefore.get(path);
    const applyFallback = (target: VerifyTarget): void => {
      if (superseded(target.change.path)) return;
      this.learnedAt.delete(target.change.path);
      this.statuses.set(target.change.path, { key: this.keyOf(target.change), at: this.now(), review: target.fallback, light: true });
    };
    const verifyViaStatus = async (list: readonly VerifyTarget[]): Promise<void> => {
      for (const target of list) {
        const doc = this.deps.documentFor(target.change.path);
        if (!doc) continue;
        const review = await this.deps.review.status(doc);
        if ((this.deps.place?.() ?? "") !== place || this.disposed) return;
        if (review === null || superseded(target.change.path)) continue;
        const pr = review.pr && review.pr.number === target.pr.number && target.pr.group && !review.pr.group ? { ...review.pr, group: target.pr.group } : review.pr;
        if (this.isStaleDraftDowngrade(target.change.path, pr)) continue;
        const nextReview = pr === review.pr ? review : { ...review, pr };
        const draftSig = this.draftSigOf(target.change.path, nextReview.reviewBranch);
        this.statuses.set(target.change.path, { key: this.keyOf(target.change), at: this.now(), review: nextReview, mainSha: target.change.repoSha ?? "", ...(draftSig === undefined ? {} : { draftSig }) });
        this.syncGroupDraft(pr);
        if (!pr || pr.state === "merged" || pr.state === "closed") this.learnedAt.delete(target.change.path);
      }
    };
    const numbered = targets.flatMap((target) => {
      const doc = this.deps.documentFor(target.change.path);
      return doc ? [{ target, repo: doc.repo }] : [];
    });
    if (!this.deps.review.details) {
      const statusOnes: VerifyTarget[] = [];
      for (const { target } of numbered) {
        if (needsStatus(target)) statusOnes.push(target);
        else applyFallback(target);
      }
      await verifyViaStatus(statusOnes.slice(0, LOOK_BUDGET));
      return null;
    }
    const missing: VerifyTarget[] = [];
    for (let at = 0; at < numbered.length; at += DETAILS_PER_REQUEST) {
      const run = numbered.slice(at, at + DETAILS_PER_REQUEST);
      const numbers = [...new Set(run.map((one) => one.target.pr.number))];
      const details = await this.deps.review.details(run[0]!.repo, numbers);
      if ((this.deps.place?.() ?? "") !== place || this.disposed) return null;
      if (details === null) {
        const statusOnes: VerifyTarget[] = [];
        for (const { target } of numbered.slice(at)) {
          if (needsStatus(target)) statusOnes.push(target);
          else applyFallback(target);
        }
        await verifyViaStatus(statusOnes.slice(0, LOOK_BUDGET));
        return null;
      }
      if (!(details instanceof Map)) {
        if (typeof details === "object" && "limited" in details && details.limited) {
          return details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs };
        }
        return null;
      }
      for (const { target } of run) {
        if (superseded(target.change.path)) continue;
        const detail = details.get(target.pr.number);
        if (!detail) {
          if (needsStatus(target)) missing.push(target);
          else applyFallback(target);
          continue;
        }
        if (detail.state === "merged" || detail.state === "closed") {
          this.learnedAt.delete(target.change.path);
          const endedReview: ReviewStatus | null = target.fallback?.pr?.number === target.pr.number ? { reviewBranch: null, pr: detail, ...(target.known.review?.saver ? { saver: target.known.review.saver } : {}) } : target.fallback;
          this.statuses.set(target.change.path, { key: this.keyOf(target.change), at: this.now(), review: endedReview, light: true });
          continue;
        }
        const mergedPr: PrInfo = { ...detail, url: target.pr.url || detail.url, authorLogin: target.pr.authorLogin ?? detail.authorLogin ?? null, ...(target.pr.group ? { group: target.pr.group } : {}) };
        if (this.isStaleDraftDowngrade(target.change.path, mergedPr)) continue;
        const draftSig = this.draftSigOf(target.change.path, target.known.review?.reviewBranch);
        this.statuses.set(target.change.path, {
          key: this.keyOf(target.change),
          at: this.now(),
          review: { reviewBranch: target.known.review?.reviewBranch ?? null, pr: mergedPr, ...(target.known.review?.saver ? { saver: target.known.review.saver } : {}) },
          withoutSaver: true,
          mainSha: target.change.repoSha ?? "",
          ...(draftSig === undefined ? {} : { draftSig }),
        });
        this.syncGroupDraft(mergedPr);
      }
    }
    if (missing.length > 0) await verifyViaStatus(missing.slice(0, LOOK_BUDGET));
    return null;
  }

  private rowOf(change: LocalChange): ChangeRow | null {
    const doc = this.deps.documentFor(change.path);
    if (!doc) return null;
    const known = this.statuses.get(change.path);
    const review = known?.review ?? null;
    const entry = entryFor(change, review, this.deps.openComments?.(change.path) ?? 0);
    const theirs = this.theirs?.get(change.path);
    return { change, doc, review, entry, unit: entry ?? draftEntry(change, theirs), ...(theirs ? { theirs } : {}), ...(known ? {} : { unread: true }), ...(known?.light ? { light: true as const } : {}) };
  }

  private applyFlight(changes: readonly LocalChange[]): { detailed: LocalChange[]; verify: VerifyTarget[] } {
    const flight = this.flight;
    const detailed: LocalChange[] = [];
    const verify: VerifyTarget[] = [];
    if (!flight) return { detailed, verify };
    const login = this.deps.viewerLogin?.() ?? null;
    const active = this.deps.activePath?.() ?? null;
    const now = this.now();
    let prPaths: Map<number, Set<string>> | null = null;
    const listedElsewhere = (prNumber: number, repoPath: string): boolean => {
      if (prPaths === null) {
        prPaths = new Map();
        for (const path in flight.paths) for (const entry of flight.paths[path]!) if (typeof entry.prNumber === "number" && entry.prNumber > 0) {
          let paths = prPaths.get(entry.prNumber);
          if (!paths) { paths = new Set(); prPaths.set(entry.prNumber, paths); }
          paths.add(path);
        }
      }
      const paths = prPaths.get(prNumber);
      if (!paths) return false;
      for (const path of paths) if (path !== repoPath) return true;
      return false;
    };
    for (const change of changes) {
      const known = this.statuses.get(change.path);
      const repoPath = this.deps.documentFor(change.path)?.path ?? change.path;
      const there = flight.paths[repoPath];
      const batch: BatchReview = reviewFromInFlight(there, login, flight.overviews, flight.saves);
      const listed = there !== undefined;
      const light = batch.review?.pr ?? null;
      const was = known?.review?.pr ?? null;
      const wasOpen = was !== null && was.state !== "merged" && was.state !== "closed";
      const waiting = known?.review?.saver?.state === "waiting";
      const needsActiveSaver = change.path === active && known?.withoutSaver === true;
      const learned = this.learnedAt.get(change.path);
      const withinGrace = learned !== undefined && now - learned < LEARN_GRACE_MS;
      const keepSaver = waiting ? known?.review?.saver : undefined;
      const nextReview: ReviewStatus | null = batch.review
        ? keepSaver
          ? { ...batch.review, saver: keepSaver }
          : batch.review
        : keepSaver
          ? { reviewBranch: null, pr: null, saver: keepSaver }
          : null;
      const droppedOpen = wasOpen && light === null;
      const downgradedOpen = wasOpen && !was.isDraft && was.state !== "draft" && light !== null && light.number === was.number && light.isDraft;
      if (flight.stale && known) {
        if (droppedOpen || downgradedOpen) {
          this.statuses.set(change.path, { ...known, key: this.keyOf(change) });
          if (downgradedOpen) this.syncGroupDraft(was);
          const readyToVerify = !withinGrace && was.number > 0 && now - known.at >= STATUS_TTL_MS;
          const levelExpired = this.levelAt === null || now - this.levelAt >= DETAIL_TTL_MS;
          if (readyToVerify && (listed || levelExpired)) {
            verify.push({ change, known, pr: was, fallback: nextReview, fromStale: true, downgraded: downgradedOpen });
          }
          continue;
        }
        if (!listed && this.levelAt !== null && now - this.levelAt < DETAIL_TTL_MS) {
          this.statuses.set(change.path, { ...known, key: this.keyOf(change) });
          continue;
        }
      }
      if (known && withinGrace && (light?.number !== was?.number || light?.isDraft !== was?.isDraft)) {
        if (was && light && was.number === light.number && was.isDraft !== light.isDraft) this.syncGroupDraft(was);
        continue;
      }
      if (!flight.stale && known && was && was.number > 0 && ((droppedOpen && !was.group && !listedElsewhere(was.number, repoPath)) || downgradedOpen)) {
        this.statuses.set(change.path, { ...known, key: this.keyOf(change) });
        if (downgradedOpen) this.syncGroupDraft(was);
        verify.push({ change, known, pr: was, fallback: nextReview, fromStale: false, downgraded: downgradedOpen });
        continue;
      }
      if (known && known.light !== true && !waiting && !needsActiveSaver && !was && !light && !known.review?.reviewBranch && !batch.review && now - known.at < DETAIL_TTL_MS) {
        this.statuses.set(change.path, { ...known, key: this.keyOf(change) });
        continue;
      }
      const draftSig = this.draftSigOf(change.path, batch.review?.reviewBranch ?? known?.review?.reviewBranch);
      const mainSha = change.repoSha ?? "";
      const mainChanged = known !== undefined && known.light !== true && known.mainSha !== undefined && known.mainSha !== mainSha && was !== null;
      const dirtyMoved = was?.mergeableState === "dirty" && draftSig !== undefined && known?.draftSig !== draftSig;
      const liveMainDiverged = this.deps.isLive?.(change.path) === true && (change.mainMoved || (change.repoSha !== null && change.baseUnknown));
      const choiceMoved = (this.current.choices.has(change.path) || liveMainDiverged) && light !== null && draftSig !== undefined && known?.draftSig !== draftSig;
      const expiredDirty = was?.mergeableState === "dirty" && known !== undefined && known.light !== true && now - known.at >= DETAIL_TTL_MS;
      if (known && known.light !== true && !waiting && !needsActiveSaver && !dirtyMoved && !choiceMoved && !mainChanged && was && light && was.number === light.number && was.isDraft === light.isDraft && now - known.at < DETAIL_TTL_MS) {
        const keepSig = draftSig ?? known.draftSig;
        this.statuses.set(change.path, { ...known, key: this.keyOf(change), ...(keepSig === undefined ? {} : { draftSig: keepSig }), review: { reviewBranch: batch.review!.reviewBranch ?? known.review?.reviewBranch ?? null, pr: { ...was, ...(light.group ? { group: light.group, mergeableState: light.mergeableState } : {}) }, ...(known.review?.saver ? { saver: known.review.saver } : {}) } });
        continue;
      }
      this.statuses.set(change.path, { key: this.keyOf(change), at: now, review: nextReview, light: true, ...(draftSig === undefined ? {} : { draftSig }) });
      if (batch.needsDetail || waiting || needsActiveSaver || dirtyMoved || choiceMoved || expiredDirty) detailed.push(change);
    }
    return { detailed, verify };
  }

  private async rowsFor(changes: LocalChange[]): Promise<{ rows: ChangeRow[]; limited: { retryAfterMs?: number } | null }> {
    const listed = new Set(changes.map((change) => change.path));
    for (const path of [...this.statuses.keys()]) if (!listed.has(path)) this.statuses.delete(path);
    for (const path of [...this.learnedAt.keys()]) if (!this.statuses.has(path)) this.learnedAt.delete(path);
    const active = this.deps.activePath?.() ?? null;
    const place = this.deps.place?.() ?? "";
    const applied = this.flight ? this.applyFlight(changes) : { detailed: [], verify: [] };
    let limited = await this.verifyReviews(applied.verify);
    if ((this.deps.place?.() ?? "") !== place || this.disposed) {
      this.statuses.clear();
      this.learnedAt.clear();
      return { rows: [], limited: null };
    }
    const wanted = [...applied.detailed].sort((a, b) => Number(b.path === active) - Number(a.path === active));
    if (limited === null) {
      const asked = await this.ask(wanted.slice(0, LOOK_BUDGET), "look");
      limited = asked.limited;
    }
    if ((this.deps.place?.() ?? "") !== place) {
      this.statuses.clear();
      this.learnedAt.clear();
    }
    const rows = changes.flatMap((change) => this.rowOf(change) ?? []);
    if (limited !== null) return { rows, limited };
    if (wanted.length > LOOK_BUDGET) this.lookLater(FILL_IN_MS);
    else if (this.flight) {
      const wait = this.asking.after({ stale: this.flight.stale });
      if (wait !== null) this.lookLater(wait);
    } else if (!this.draftsChecked || changes.some((change) => !this.statuses.has(change.path))) this.lookLater(RETRY_MS);
    return { rows, limited: null };
  }

  watchUnchanged(path: string | null): void {
    if (path === null || this.row(path)) {
      this.watched = null;
      return;
    }
    if (this.watched?.path === path) return;
    this.watched = { path, review: null, read: false, version: 0, learnedAt: null };
    void this.readWatched(true);
  }

  private async readWatched(first = false): Promise<void> {
    const watched = this.watched;
    if (!watched || this.disposed || this.current.busy || this.row(watched.path)) return;
    const doc = this.deps.documentFor(watched.path);
    if (!doc) return;
    const listed = (this.flight?.paths[doc.path]?.length ?? 0) > 0;
    if (!first && !listed && !this.ownOpen(watched.review) && watched.review?.saver?.state !== "waiting" && this.sentTo(watched.path) === null) return;
    const place = this.deps.place?.() ?? "";
    const version = watched.version;
    const review = await this.deps.review.status(doc);
    if (review === null || this.watched !== watched || watched.version !== version || this.disposed || (this.deps.place?.() ?? "") !== place) return;
    if (this.heldByStep(watched, review.pr)) return;
    watched.review = review;
    watched.read = true;
    this.listeners.forEach((listener) => listener());
  }

  private ownOpen(review: ReviewStatus | null): boolean {
    const pull = review?.pr;
    const viewer = this.deps.viewerLogin?.();
    return !!pull && (pull.state === "open" || pull.state === "draft") && viewer !== undefined && !isAnotherAuthor(pull.authorLogin, viewer);
  }

  private heldByStep(watched: Watched, heard: PrInfo | null | undefined): boolean {
    if (watched.learnedAt === null || this.now() - watched.learnedAt >= LEARN_GRACE_MS) return false;
    const known = watched.review?.pr ?? null;
    return (heard?.number ?? null) !== (known?.number ?? null) || (heard?.isDraft ?? null) !== (known?.isDraft ?? null);
  }

  unchangedRow(path: string): ChangeRow | undefined {
    const watched = this.watched;
    if (!watched || watched.path !== path || this.row(path)) return undefined;
    const review = watched.review;
    const pull = review?.pr;
    if (!review || !pull || (pull.state !== "open" && pull.state !== "draft")) return undefined;
    if (pull.group || this.groupOf(path)) return undefined;
    const viewer = this.deps.viewerLogin?.();
    if (viewer === undefined || isAnotherAuthor(pull.authorLogin, viewer)) return undefined;
    const doc = this.deps.documentFor(path);
    if (!doc) return undefined;
    const change = { kind: "edited" as const, path, sha: "", repoSha: null, mainMoved: false, baseUnknown: true, base: null };
    const entry = entryFor(change, review, this.deps.openComments?.(path) ?? 0);
    return entry ? { change, doc, review, entry, unit: entry, unchanged: true } : undefined;
  }

  private async readUnchanged(row: ChangeRow): Promise<ChangeRow> {
    const watched = this.watched?.path === row.change.path ? this.watched : null;
    const place = this.deps.place?.() ?? "";
    const review = await this.deps.review.status(row.doc);
    if (review !== null && watched && this.watched === watched && !this.disposed && (this.deps.place?.() ?? "") === place) {
      const current = watched.review?.pr ?? null;
      const staleDowngrade =
        watched.learnedAt !== null &&
        this.now() - watched.learnedAt < LEARN_GRACE_MS &&
        current !== null &&
        current.state !== "merged" &&
        current.state !== "closed" &&
        !current.isDraft &&
        current.state !== "draft" &&
        review.pr !== null &&
        review.pr.state !== "merged" &&
        review.pr.state !== "closed" &&
        review.pr.number === current.number &&
        (review.pr.isDraft || review.pr.state === "draft");
      if (!staleDowngrade) {
        watched.review = review;
        watched.read = true;
        watched.version++;
      }
    }
    const now = review ?? row.review;
    return this.unchangedRow(row.change.path) ?? { ...row, review: now, entry: entryFor(row.change, now, this.deps.openComments?.(row.change.path) ?? 0) };
  }

  async read(rows: readonly ChangeRow[]): Promise<ChangeRow[]> {
    const asks = this.ask(rows.filter((row) => !row.unchanged).map((row) => row.change).filter((change) => !this.fresh(change)), "step");
    const unchanged = new Map((await Promise.all(rows.filter((row) => row.unchanged).map((row) => this.readUnchanged(row)))).map((row) => [row.change.path, row]));
    const { failedReads: failed } = await asks;
    const fresh = rows.map((row) => (row.unchanged ? (unchanged.get(row.change.path) ?? row) : failed.has(row.change.path) ? { ...(this.rowOf(row.change) ?? row), unchecked: true } : (this.rowOf(row.change) ?? row)));
    const by = new Map(fresh.filter((row) => !row.unchanged).map((row) => [row.change.path, row]));
    this.set({ rows: this.current.rows.map((row) => by.get(row.change.path) ?? row) });
    return fresh;
  }

  async readFromInFlight(rows: readonly ChangeRow[]): Promise<ChangeRow[]> {
    const place = this.deps.place?.() ?? "";
    const mapFresh = (): boolean => this.flight !== null && !this.flight.stale && this.levelAt !== null && this.now() - this.levelAt < STATUS_TTL_MS;
    if (!mapFresh() && this.deps.groups) {
      const groups = await this.readGroups();
      if ((this.deps.place?.() ?? "") !== place || this.disposed) return this.read(rows);
      if (groups.kind === "rate_limited") {
        this.enterRateLimit(groups.retryAfterMs, {}, "groups");
        return rows.map((row) => ({ ...row, unchecked: true }));
      }
      const asked = this.readFlight(groups);
      if (asked) {
        this.flight = asked;
        this.draftsChecked = true;
        if (!asked.stale) this.levelAt = this.now();
      }
    }
    if (!mapFresh()) return this.read(rows);
    const changes = rows.filter((row) => !row.unchanged).map((row) => row.change);
    const { verify } = this.applyFlight(changes);
    const limited = await this.verifyReviews(verify);
    const unchanged = new Map((await Promise.all(rows.filter((row) => row.unchanged).map((row) => this.readUnchanged(row)))).map((row) => [row.change.path, row]));
    const fresh = rows.map((row) => (row.unchanged ? (unchanged.get(row.change.path) ?? row) : (this.rowOf(row.change) ?? row)));
    const by = new Map(fresh.filter((row) => !row.unchanged).map((row) => [row.change.path, row]));
    const nextRows = this.current.rows.map((row) => by.get(row.change.path) ?? row);
    if (limited !== null) {
      this.enterRateLimit(limited.retryAfterMs, { rows: nextRows }, "details");
    } else {
      this.set({ rows: nextRows });
    }
    return fresh;
  }

  rebased(path: string, sha: string): void {
    this.deps.cache.rebased(path, sha);
    this.deps.cache.save();
    const file = this.states?.files.get(path);
    const now = file && rebasedOnto(file, sha);
    if (!this.states || !now || now === file) return;
    this.states = { ...this.states, files: new Map(this.states.files).set(path, now) };
    const change = changeOf(now);
    if (change) this.set({ rows: this.current.rows.map((one) => (one.change.path === path ? { ...one, change } : one)) });
  }

  readOnly(): boolean {
    return this.denied;
  }

  offline(): boolean {
    return this.current.phase === "offline";
  }

  writesOff(repo: string): string | null {
    return writesOffWords(this.offline(), this.denied, repo);
  }

  publishQuota(): PublishQuota | null {
    return this.quota;
  }

  wroteOk(): void {
    if (!this.denied) return;
    this.denied = false;
    this.set({});
  }

  learnSame(path: string, sha: string, repoSha: string, by?: "server"): void {
    this.deps.cache.sameAs(path, sha, repoSha, by);
    this.deps.cache.save();
  }

  attachmentSha(vaultPath: string): string | null | undefined {
    return this.attachmentShas === null ? undefined : (this.attachmentShas.get(vaultPath) ?? null);
  }

  holdOf(path: string): string | null {
    return this.deps.heldWhy?.(path) ?? null;
  }

  toldWords(path: string): string | null {
    return this.toldOf(path).join(" ") || null;
  }

  sentSha(path: string): string | null {
    return this.deps.cache.get(path)?.sent ?? null;
  }

  sentTo(path: string): ReviewKey | null {
    return (this.deps.cache.get(path)?.sentTo as ReviewKey | undefined) ?? null;
  }

  reviewOf(path: string): ReviewKey | null {
    const group = this.groupOf(path)?.group;
    if (group) return `group:${group.overview.prNumber}`;
    const row = this.row(path);
    return reviewKey(row?.review?.pr) ?? (typeof row?.theirs?.prNumber === "number" ? `pr:${row.theirs.prNumber}` : null);
  }

  learnSent(path: string, sha: string | null, to: ReviewKey | null = null, agreement: { agreed?: string; commit?: string } = {}): void {
    this.deps.cache.sentAs(path, sha, to, sha === null ? {} : { ...agreement, at: this.now() });
    this.deps.cache.save();
  }

  learnSentMany(sent: Iterable<readonly [string, string | null, (ReviewKey | null)?, { agreed?: string; commit?: string }?]>): void {
    for (const [path, sha, to, agreement] of sent) this.deps.cache.sentAs(path, sha, to ?? null, sha === null ? {} : { ...agreement, at: this.now() });
    this.deps.cache.save();
  }

  learnAgreed(path: string, agreed: string): void {
    this.deps.cache.agreedAs(path, agreed);
    this.deps.cache.save();
  }

  placeNow(): string {
    return this.deps.place?.() ?? "";
  }

  settledDelete(path: string): void {
    this.deps.cache.dropped(path);
  }

  row(path: string): ChangeRow | undefined {
    return this.lookups().rows.get(path);
  }

  saverOf(path: string): SaverStatus | null {
    const review = this.statuses.get(path)?.review ?? (this.watched?.path === path ? this.watched.review : null);
    return review?.saver ?? null;
  }

  roomsNow(): ReadonlyMap<string, readonly string[]> {
    return this.awareness.rooms((path) => this.vaultPathFor(path));
  }

  vaultHas(path: string): boolean {
    return this.awareness.hasFile(path);
  }

  mtimeOf(path: string): number | undefined {
    return this.deps.cache.get(path)?.mtime;
  }

  flightAnswer(): InFlightResponse | null {
    const flight = this.flight;
    if (!flight) return null;
    const paths: Record<string, InFlightResponse["paths"][string]> = {};
    for (const path in flight.paths) {
      const here = this.vaultPathFor(path);
      if (this.isSupersededDraftSource(here)) continue;
      if (this.deps.documentFor(here) !== null && !isHiddenPath(here)) paths[here] = flight.paths[path]!;
    }
    return { base: "", paths, groups: this.vaultOverviews() ?? {} };
  }
}
