import { CATCH_UP, type CatchUpPreview, isViewersBranch, sameLogin, type SaverStatus, TRY_AGAIN } from "../shared/review-flow";
import type { ActionAnswer, PanelAction, PanelHost, ReviewFacts, StatusNotice, StatusReviewer } from "../shared/status-panel";
import { comparedOf, onGitHubFiles, type VaultStates } from "../changes/vault-state";
import { type Built, panelModelFromVault, type VaultPanelBase, vaultPanelOf } from "./panel-model";
import { runAction, type StatusFlows, type StatusPorts } from "./panel-actions";
import type { ChangeRow, ChangesModel, ChangesPhase, ChangesState } from "../changes/model";
import type { Dialogs } from "../changes/flow-deps";
import type { PanelState } from "../panel/model";
import type { PanelActions } from "../panel/panel";
import type { ReviewApi } from "../review/review-api";
import { factsOf } from "../review/review-api";
import { CATCH_UP_HERE } from "../review/words";
import { viewsOf } from "../changes/vault-since";
import { type DocumentRef, noteName, pathKind } from "../mapping";
import type { BroughtDraft } from "../changes/bring-in";
import { phaseOf, type NoteStatus } from "../status";
import { DraftHold, HELD_RECHECK_MS } from "./draft-hold";
import type { GithubStatusReader } from "./github-status";

export const FACTS_PER_REQUEST = 50;
export const FACTS_FRESH_MS = 120_000;
export const FACTS_RETRY_MS = 15_000;
export const FACTS_RETRY_MAX_MS = 120_000;
export const RECOVERY_JITTER_MIN_MS = 500;
export const RECOVERY_JITTER_MAX_MS = 4_000;
export { HELD_RECHECK_MS };

export interface StatusEnv {
  model: ChangesModel;
  flows: StatusFlows;
  review: Pick<ReviewApi, "details">;
  dialogs: Pick<Dialogs, "confirm" | "toast">;
  viewer: () => string;
  repo: () => string;
  folder: () => string;
  place: () => string;
  activePath: () => string | null;
  storage: { load: (key: string) => unknown; save: (key: string, value: unknown) => void };
  note: { open: (path: string) => void; openInSpecgit: (path: string) => void; openUrl: (url: string) => void; join?: (path: string) => void };
  copyIn: () => Promise<void>;
  bringInNewer: () => Promise<unknown>;
  bringInDraft: (path: string) => Promise<BroughtDraft>;
  isLive: (path: string) => boolean;
  stayOn?: () => boolean;
  isPaused?: (path: string) => boolean;
  openComments: (path: string) => number;
  offered?: () => readonly string[];
  addOffered?: () => void;
  inVault: (path: string) => boolean;
  documentFor: (path: string) => DocumentRef | null;
  ask: PanelHost["confirm"];
  openMenu: PanelHost["openMenu"];
  touch?: boolean;
  since: SinceView;
  plansUrl: () => string;
  githubStatus?: GithubStatusReader;
  now?: () => number;
  random?: () => number;
  timers?: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}

export class SinceView {
  private open: { path: string; close: () => void } | null = null;
  private pending: string | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  expect(path: string): void {
    this.pending = path;
  }

  opened(close: () => void): void {
    this.open = { path: this.pending ?? "", close };
    this.pending = null;
    this.listeners.forEach((listener) => listener());
  }

  closed(): void {
    this.open = null;
    this.listeners.forEach((listener) => listener());
  }

  isOpenFor(path: string): boolean {
    return this.open !== null && this.open.path === path;
  }

  close(): void {
    this.open?.close();
  }
}

const CHECKED_KEY = (place: string): string => `specgit-status-checked:${place}`;

function saverSignature(saver: SaverStatus | null): string {
  return saver ? `${saver.state}\0${saver.reason ?? ""}` : "";
}

function statusSignature(status: NoteStatus | null): string {
  const phase = phaseOf(status);
  const here = status?.here;
  if (!here || here.length === 0) return phase;
  return `${phase}\0${here.map((one) => `${one.login ?? one.name}\u0001${one.picture ?? ""}`).join("\0")}`;
}

function unchangedSignature(row: ChangeRow | undefined): string {
  if (!row?.entry) return "";
  const { entry, review } = row;
  const pr = review?.pr;
  return [
    row.change.path,
    entry.prNumber,
    entry.prUrl,
    entry.isDraft ? "1" : "0",
    entry.stage,
    entry.openComments,
    entry.requestedReviewers.join(","),
    pr?.state ?? "",
    pr?.mergeableState ?? "",
    pr?.reviewPolicy?.reviewDecision ?? "",
    pr?.autoMergeEnabled ? "1" : "0",
    review?.saver?.state ?? "",
    review?.saver?.reason ?? "",
  ].join("\0");
}

export interface StatusView {
  state: PanelState;
  actions: PanelActions;
}

export function catchUpQuestion(row: ChangeRow, preview: CatchUpPreview | null): Parameters<StatusEnv["dialogs"]["confirm"]>[0] {
  const changes = preview?.kind === "behind" ? preview.changes : null;
  const submitted = row.entry !== null && !row.entry.isDraft;
  return {
    title: CATCH_UP_HERE.title,
    confirmLabel: CATCH_UP_HERE.button,
    description: [CATCH_UP_HERE.body(noteName(row.change.path)), submitted ? CATCH_UP_HERE.lookAgain : ""].filter(Boolean).join(" "),
    ...(changes
      ? {
          points: changes.lines.map((line) => ({ icon: "file-diff", text: CATCH_UP.line(line) })),
          note: [changes.summary, changes.more > 0 ? CATCH_UP.moreLines(changes.more) : ""].filter(Boolean).join(" "),
        }
      : {}),
  };
}

export class StatusController {
  private readonly listeners = new Set<() => void>();
  private facts = new Map<number, ReviewFacts>();
  private factsFor = "";
  private readonly holds: DraftHold;
  private seq = 0;
  private asked = "";
  private askedSet = new Set<number>();
  private readAt = 0;
  private retry: unknown = null;
  private retryMs = FACTS_RETRY_MS;
  private limitedUntil = 0;
  private fullRefreshPending = false;
  private pendingRefresh = new Set<number>();
  private draftSigs = new Map<number, string>();
  private lastChoices = new Set<string>();
  private wasBusy = false;
  private reading: Promise<void> | null = null;
  private again = false;
  private checked: readonly string[] | null = null;
  private checkedFor = "";
  private reviewers: readonly StatusReviewer[] = [];
  private notice: StatusNotice | null = null;
  private editing: string | null = null;
  private behind: { path: string; blob: string; behind: boolean } | null = null;
  private previewing = "";
  private version = 0;
  private vaultVersion = 0;
  private vaultBuilt: { key: unknown[]; value: VaultPanelBase } | null = null;
  private vaultToldById = new Map<string, string | null>();
  private built: { key: unknown[]; value: Built } | null = null;
  private lastView: StatusView | null = null;
  private lastViewMeta = "";
  private lastModelState: ChangesState;
  private lastModelVault: VaultStates | null;
  private watchedPath: string | null = null;
  private watchedSignature = "";
  private watchedSaver = "";
  private watchedReadPending = false;
  private units: Built["units"] = { rows: new Map(), members: new Map(), urls: new Map() };
  private disposed = false;
  private readonly stops: Array<() => void> = [];
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly env: StatusEnv) {
    this.now = env.now ?? Date.now;
    this.random = env.random ?? Math.random;
    this.lastModelState = env.model.state();
    this.lastModelVault = env.model.vault();
    this.draftSigs = this.currentDraftSigs() ?? new Map<number, string>();
    this.lastChoices = new Set(this.lastModelState.choices.keys());
    this.holds = new DraftHold({
      now: this.now,
      repo: () => env.repo(),
      setTimer: (run, ms) => this.setTimer(run, ms),
      clearTimer: (handle) => this.clearTimer(handle),
      recheck: (numbers) => void (this.disposed ? undefined : this.read(false, numbers)),
      onChanged: () => {
        if (!this.disposed) this.changed();
      },
    });
    this.stops.push(env.model.onLooked(() => this.look()));
    this.stops.push(env.model.subscribe(() => this.modelChanged()));
    this.stops.push(env.model.onDraftMoved((prNumber, isDraft, requestedReviewers) => this.holdDraft(prNumber, isDraft, requestedReviewers)));
    this.stops.push(env.since.subscribe(() => this.changed(false)));
    if (env.githubStatus) {
      this.stops.push(env.githubStatus.subscribe(() => this.changed(false)));
      this.stops.push(env.githubStatus.onRecover(() => this.githubRecovered()));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.limitedUntil = 0;
    this.fullRefreshPending = false;
    this.pendingRefresh.clear();
    this.draftSigs.clear();
    this.lastChoices.clear();
    this.cancelRetry();
    this.holds.clear();
    this.stops.forEach((stop) => stop());
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private changed(vaultWide = true): void {
    if (vaultWide) this.vaultVersion++;
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  private shouldRead(prNumber: number): boolean {
    return this.holds.has(prNumber) || this.facts.get(prNumber)?.isDraft === false || this.facts.get(prNumber)?.mergeableState === "dirty";
  }

  private numbers(): number[] {
    return this.collectNumbers().all;
  }

  private collectNumbers(): { all: number[]; ordered: number[]; known: Set<number> } {
    const { rows, groups, choices } = this.env.model.state();
    const known = new Set<number>();
    const found = new Set<number>();
    const own = new Set<number>();
    for (const row of rows) {
      const n = row.entry?.prNumber ?? 0;
      if (n <= 0) continue;
      known.add(n);
      const diverged = row.change.mainMoved || (row.change.repoSha !== null && row.change.baseUnknown);
      if (!row.entry!.isDraft || row.entry!.stage === "conflicts" || diverged || choices.has(row.change.path) || this.shouldRead(n)) {
        found.add(n);
        own.add(n);
      }
    }
    for (const card of groups) {
      const overview = card.group?.overview;
      if (!overview || overview.prNumber <= 0) continue;
      const n = overview.prNumber;
      known.add(n);
      if (!overview.isDraft || this.shouldRead(n)) {
        found.add(n);
        own.add(n);
      }
    }
    const viewer = this.env.viewer();
    const flight = this.env.model.flightAnswer();
    const paths = flight?.paths;
    if (paths) {
      for (const key in paths) {
        for (const one of paths[key]!) {
          if (!one.isReviewBranch || one.changedStatus === "removed") continue;
          if (one.prNumber === undefined || one.prNumber <= 0) continue;
          const n = one.prNumber;
          known.add(n);
          if (one.prIsDraft === false || choices.has(key) || this.shouldRead(n)) {
            found.add(n);
            if (isViewersBranch(one, viewer)) own.add(n);
          }
        }
      }
    }
    const flightGroups = flight?.groups;
    if (flightGroups) {
      for (const key in flightGroups) {
        const overview = flightGroups[key]!;
        if (overview.prNumber <= 0) continue;
        const n = overview.prNumber;
        known.add(n);
        if (!overview.isDraft || this.shouldRead(n)) {
          found.add(n);
          if (sameLogin(overview.authorLogin, viewer)) own.add(n);
        }
      }
    }
    const all = [...found].sort((a, b) => a - b);
    return { all, ordered: [...all.filter((number) => own.has(number)), ...all.filter((number) => !own.has(number))], known };
  }

  private setTimer(run: () => void, ms: number): unknown {
    return (this.env.timers?.set ?? ((fn, wait) => window.setTimeout(fn, wait)))(run, ms);
  }

  private clearTimer(handle: unknown): void {
    (this.env.timers?.clear ?? ((id) => window.clearTimeout(id as number)))(handle);
  }

  private cancelRetry(): void {
    if (this.retry === null) return;
    this.clearTimer(this.retry);
    this.retry = null;
  }

  private scheduleRetry(wait: number, after?: () => void): void {
    this.cancelRetry();
    const run = (): void => {
      this.retry = null;
      if (this.disposed) return;
      after?.();
      void this.read(true);
    };
    this.retry = this.setTimer(run, wait);
  }

  private jitter(ms: number): number {
    return Math.round(ms * (0.8 + this.random() * 0.4));
  }

  private retryLater(): void {
    const wait = this.jitter(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, FACTS_RETRY_MAX_MS);
    this.scheduleRetry(wait);
  }

  private githubRecovered(): void {
    if (this.disposed) return;
    this.limitedUntil = 0;
    this.retryMs = FACTS_RETRY_MS;
    this.fullRefreshPending = true;
    const wait = Math.round(RECOVERY_JITTER_MIN_MS + this.random() * (RECOVERY_JITTER_MAX_MS - RECOVERY_JITTER_MIN_MS));
    this.scheduleRetry(wait, () => {
      if (this.env.model.state().phase === "offline") void this.env.model.refresh?.();
    });
  }

  private syncRepo(): void {
    const repo = this.env.repo();
    if (this.factsFor === repo) return;
    this.factsFor = repo;
    this.facts = new Map();
    this.asked = "";
    this.askedSet = new Set();
    this.readAt = 0;
    this.limitedUntil = 0;
    this.fullRefreshPending = false;
    this.pendingRefresh.clear();
    this.draftSigs.clear();
    this.lastChoices.clear();
    this.cancelRetry();
    this.holds.clear();
  }

  private syncNumbers(current: readonly number[]): void {
    this.syncRepo();
    const nextKey = current.join(",");
    if (nextKey === this.asked) return;
    if (this.readAt === 0) {
      void this.read();
      return;
    }
    const added = current.filter((number) => !this.askedSet.has(number));
    this.asked = nextKey;
    this.askedSet = new Set(current);
    if (added.length > 0) {
      void this.read(false, added);
      return;
    }
    if (!this.reading) {
      const kept = new Map<number, ReviewFacts>();
      for (const number of current) {
        const fact = this.facts.get(number);
        if (fact) kept.set(number, fact);
      }
      if (kept.size !== this.facts.size) {
        this.facts = kept;
        this.changed();
      }
    }
  }

  holdDraft(prNumber: number, isDraft: boolean, requestedReviewers?: readonly string[]): void {
    if (this.disposed) return;
    this.syncRepo();
    if (this.holds.record(prNumber, isDraft, ++this.seq, this.facts, this.reading !== null, requestedReviewers)) this.changed();
  }

  private joinKeyOf(vaultBase: VaultPanelBase): string {
    return vaultBase.joinCandidates.length === 0 ? "" : vaultBase.joinCandidates.map(({ raw }) => (this.env.isLive(raw.id) ? "1" : "0")).join("");
  }

  private viewMeta(vaultBase: VaultPanelBase, view: StatusView | null): string {
    const path = this.shownPath(view);
    const stay = view ? view.state.stay : this.env.stayOn?.() === true;
    const paused = path !== null && this.env.isPaused?.(path) === true;
    const hold = path !== null ? this.env.model.holdOf(path) : null;
    return [stay ? "1" : "0", paused ? "1" : "0", hold ?? "", this.joinKeyOf(vaultBase)].join("\0");
  }

  private vaultMetaChanged(): boolean {
    if (!this.vaultBuilt) return true;
    const { model } = this.env;
    if (this.vaultBuilt.key[4] !== (this.env.offered?.().length ?? 0)) return true;
    if (this.vaultBuilt.key[5] !== this.env.viewer()) return true;
    if (this.vaultBuilt.key[6] !== this.env.folder()) return true;
    for (const [id, prev] of this.vaultBuilt.value.holdById) {
      if (model.holdOf(id) !== prev) return true;
    }
    for (const [id, prev] of this.vaultToldById) {
      if (model.toldWords(id) !== prev) return true;
    }
    return false;
  }

  private currentDraftSigs(): Map<number, string> | null {
    const paths = this.env.model.flightAnswer?.()?.paths;
    if (!paths) return null;
    const grouped = new Map<number, string[]>();
    for (const path in paths) {
      for (const one of paths[path]!) {
        if (one.prNumber === undefined || one.prNumber <= 0) continue;
        const list = grouped.get(one.prNumber);
        const item = `${path}\0${one.docBlobSha ?? ""}\0${one.lastCommitAt ?? ""}`;
        if (list) list.push(item);
        else grouped.set(one.prNumber, [item]);
      }
    }
    const sigs = new Map<number, string>();
    for (const [number, list] of grouped) sigs.set(number, list.sort().join("\n"));
    return sigs;
  }

  private dirtyDraftsMoved(): number[] {
    const moved = new Set<number>();
    const nextSigs = this.currentDraftSigs();
    if (nextSigs !== null) {
      for (const [number, sig] of nextSigs) {
        const prev = this.draftSigs.get(number);
        if (prev !== sig && this.facts.get(number)?.mergeableState === "dirty") moved.add(number);
      }
      this.draftSigs = nextSigs;
    }
    const choices = new Set(this.env.model.state().choices.keys());
    const flightPaths = this.env.model.flightAnswer?.()?.paths;
    for (const path of this.lastChoices) {
      if (choices.has(path)) continue;
      const prNumber = this.env.model.row(path)?.entry?.prNumber ?? this.env.model.unchangedRow(path)?.entry?.prNumber;
      if (prNumber !== undefined && prNumber > 0 && this.facts.get(prNumber)?.mergeableState === "dirty") moved.add(prNumber);
      for (const one of flightPaths?.[path] ?? []) {
        if (one.prNumber !== undefined && one.prNumber > 0 && this.facts.get(one.prNumber)?.mergeableState === "dirty") moved.add(one.prNumber);
      }
    }
    this.lastChoices = choices;
    return [...moved];
  }

  private dispatchDirty(dirtyMoved: readonly number[]): boolean {
    if (this.pendingRefresh.size === 0 && dirtyMoved.length === 0) return false;
    if (this.pendingRefresh.size === 0 && this.reading !== null) void this.read(false, dirtyMoved);
    else {
      for (const number of dirtyMoved) this.pendingRefresh.add(number);
      void this.read(true);
    }
    return true;
  }

  private modelChanged(): void {
    if (this.disposed) return;
    this.syncRepo();
    const state = this.env.model.state();
    const vault = this.env.model.vault();
    const sameVault = state === this.lastModelState && vault === this.lastModelVault;
    this.lastModelState = state;
    this.lastModelVault = vault;
    const { busy } = state;
    const ended = this.wasBusy && !busy;
    this.wasBusy = busy;
    const dirtyMoved = this.dirtyDraftsMoved();
    if (state.phase === "rate-limited") {
      for (const number of dirtyMoved) this.pendingRefresh.add(number);
    } else if (ended || this.fullRefreshPending) {
      void this.read();
    } else if (!this.dispatchDirty(dirtyMoved)) {
      this.syncNumbers(this.numbers());
    }
    this.preview();
    if (sameVault && this.watchedPath !== null && !this.vaultMetaChanged()) {
      const nextSig = unchangedSignature(this.env.model.unchangedRow(this.watchedPath));
      const nextSaver = saverSignature(this.env.model.saverOf(this.watchedPath));
      if (nextSig !== this.watchedSignature || nextSaver !== this.watchedSaver) {
        this.watchedSignature = nextSig;
        this.watchedSaver = nextSaver;
        this.watchedReadPending = false;
        this.changed(false);
        return;
      }
      if (this.watchedReadPending) {
        this.watchedReadPending = false;
        if (this.vaultBuilt && this.viewMeta(this.vaultBuilt.value, this.lastView) !== this.lastViewMeta) {
          this.changed(false);
        }
        return;
      }
    }
    this.changed();
  }

  private look(): void {
    if (this.disposed) return;
    this.syncRepo();
    void this.env.githubStatus?.refresh();
    const dirtyMoved = this.dirtyDraftsMoved();
    if (this.env.model.state().phase === "rate-limited") {
      for (const number of dirtyMoved) this.pendingRefresh.add(number);
      return;
    }
    if (this.readAt === 0 || this.fullRefreshPending || this.now() - this.readAt >= FACTS_FRESH_MS) void this.read();
    else if (!this.dispatchDirty(dirtyMoved)) this.syncNumbers(this.numbers());
  }

  reviewsChanged(): void {
    if (this.disposed) return;
    void this.env.githubStatus?.refresh();
    void this.read();
  }

  private read(retrying = false, only?: readonly number[]): Promise<void> {
    this.syncRepo();
    if (this.env.model.state().phase === "rate-limited") {
      if (only) for (const number of only) this.pendingRefresh.add(number);
      else if (!retrying) this.fullRefreshPending = true;
      return this.reading ?? Promise.resolve();
    }
    const repo = this.env.repo();
    const remaining = this.limitedUntil - this.now();
    if (remaining > 0) {
      if (only) for (const number of only) this.pendingRefresh.add(number);
      else if (!retrying) this.fullRefreshPending = true;
      if (this.retry === null) this.scheduleRetry(remaining);
      return this.reading ?? Promise.resolve();
    }
    this.limitedUntil = 0;
    if (this.reading) {
      if (only) for (const number of only) this.pendingRefresh.add(number);
      else this.fullRefreshPending = true;
      this.again = true;
      return this.reading;
    }
    if (!only) this.cancelRetry();
    const { all: current, ordered: numbers, known } = this.collectNumbers();
    let wanted: number[];
    if (only) {
      const targets = new Set(only);
      const listed = new Set<number>();
      wanted = [];
      for (const number of numbers) {
        if (!targets.has(number) || listed.has(number)) continue;
        listed.add(number);
        wanted.push(number);
      }
      for (const number of only) {
        if (!known.has(number) || listed.has(number)) continue;
        listed.add(number);
        wanted.push(number);
      }
      if (wanted.length === 0) return Promise.resolve();
    } else {
      this.asked = current.join(",");
      this.askedSet = new Set(current);
      const full = !retrying || this.fullRefreshPending;
      if (full) this.readAt = this.now();
      this.fullRefreshPending = false;
      const pending = this.pendingRefresh;
      this.pendingRefresh = new Set();
      wanted = full ? numbers : numbers.filter((number) => !this.facts.has(number) || pending.has(number));
    }
    const startedSeq = ++this.seq;
    this.reading = (async () => {
      const next = new Map<number, ReviewFacts>();
      let complete = true;
      let refused = false;
      let backedOff: { retryAfterMs?: number; unavailable?: true; fastFail?: boolean } | null = null;
      let stoppedAt = wanted.length;
      for (let at = 0; at < wanted.length; at += FACTS_PER_REQUEST) {
        const answer = await this.env.review.details(repo, wanted.slice(at, at + FACTS_PER_REQUEST));
        if (this.disposed || this.env.repo() !== repo) return;
        if (!(answer instanceof Map)) {
          complete = false;
          stoppedAt = at;
          if (answer === "failed") refused = true;
          else if (answer !== null) backedOff = answer;
          break;
        }
        for (const [number, detail] of answer) next.set(number, factsOf(detail));
      }
      if (this.disposed || this.env.repo() !== repo) return;
      if (complete) {
        this.retryMs = FACTS_RETRY_MS;
        this.limitedUntil = 0;
        if (wanted.length > 0) this.env.githubStatus?.noteHealthy();
      } else if (backedOff !== null || refused) {
        for (const number of wanted.slice(stoppedAt)) this.pendingRefresh.add(number);
        if (refused || backedOff?.unavailable) {
          if (backedOff?.fastFail) this.env.githubStatus?.noteFastFail(backedOff.retryAfterMs);
          void this.env.githubStatus?.refresh();
        }
        if (backedOff !== null) {
          const wait = backedOff.retryAfterMs ?? this.jitter(this.retryMs);
          if (backedOff.retryAfterMs === undefined) this.retryMs = Math.min(this.retryMs * 2, FACTS_RETRY_MAX_MS);
          this.limitedUntil = this.now() + wait;
          this.scheduleRetry(wait);
        } else this.retryLater();
      }
      if (complete || next.size > 0) {
        const kept = new Map<number, ReviewFacts>();
        for (const number of numbers) {
          const fresh = next.get(number) ?? this.facts.get(number);
          if (fresh) kept.set(number, fresh);
        }
        for (const [number, fresh] of next) {
          if (known.has(number) && !kept.has(number)) kept.set(number, fresh);
        }
        this.facts = kept;
        this.holds.reconcile(this.facts, next, startedSeq);
        this.changed();
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.reading = null;
        if (this.again && !this.disposed) {
          this.again = false;
          const full = this.fullRefreshPending;
          void this.read(!full);
        }
      });
    return this.reading;
  }

  private preview(): void {
    const path = this.env.activePath();
    const state = this.env.model.state();
    const row = path === null ? undefined : this.env.model.row(path);
    if (!path || !row || !row.entry || state.busy) return;
    const draftSig = this.draftSigs.get(row.entry.prNumber) ?? "";
    const key = `${path}|${row.entry.prNumber}|${row.change.sha}|${row.change.repoSha ?? ""}|${draftSig}`;
    if (key === this.previewing) return;
    this.previewing = key;
    void this.env.flows.preview(row.doc).then((answer: CatchUpPreview | null) => {
      if (this.disposed || this.previewing !== key) return;
      this.behind = { path, blob: answer?.kind === "behind" ? answer.mainBlob : "", behind: answer?.kind === "behind" };
      this.changed(false);
    });
  }

  private activeFile(view: StatusView | null): { path: string; liveCapable: boolean } | null {
    if (view) {
      if (view.state.note) return this.env.documentFor(view.state.note.path) === null ? null : { path: view.state.note.path, liveCapable: true };
      const file = view.state.file;
      if (file && (file.kind === "board" || file.kind === "base") && this.env.documentFor(file.path) !== null) return { path: file.path, liveCapable: false };
      return null;
    }
    const path = this.env.activePath();
    if (path === null) return null;
    const kind = pathKind(path);
    if (kind === "other" || this.env.documentFor(path) === null) return null;
    return { path, liveCapable: kind === "note" };
  }

  private shownPath(view: StatusView | null): string | null {
    return this.activeFile(view)?.path ?? null;
  }

  private isLocalOnlyNew(path: string): boolean {
    return typeof this.env.model.isLocalOnlyNew === "function" && this.env.model.isLocalOnlyNew(path);
  }

  unchangedPath(view: StatusView | null): string | null {
    const path = this.shownPath(view);
    return path !== null && !this.env.model.row(path) && !this.isLocalOnlyNew(path) ? path : null;
  }

  unreadPath(view: StatusView | null): string | null {
    const path = this.shownPath(view);
    if (path === null || this.isLocalOnlyNew(path)) return null;
    const row = this.env.model.row(path);
    return row && (row.unread || row.light) ? row.change.path : null;
  }

  readRow(path: string | null): void {
    if (path === null || this.isLocalOnlyNew(path)) return;
    const row = this.env.model.row(path);
    if (row) void this.env.model.read([row]);
  }

  watchUnchanged(path: string | null): () => void {
    const target = path !== null && this.isLocalOnlyNew(path) ? null : path;
    this.watchedPath = target;
    this.watchedSignature = target === null ? "" : unchangedSignature(this.env.model.unchangedRow(target));
    this.watchedSaver = target === null ? "" : saverSignature(this.env.model.saverOf(target));
    this.watchedReadPending = target !== null && !this.env.model.row(target);
    this.env.model.watchUnchanged(target);
    return () => {
      if (this.watchedPath === target) {
        this.watchedPath = null;
        this.watchedSignature = "";
        this.watchedSaver = "";
        this.watchedReadPending = false;
      }
      this.env.model.watchUnchanged(null);
    };
  }

  build(view: StatusView | null): Built {
    const { model } = this.env;
    this.syncRepo();
    if (this.holds.reconcile(this.facts)) {
      this.vaultVersion++;
      this.version++;
    }
    const state = model.state();
    const vault = model.vault();
    const viewer = this.env.viewer();
    const linked = this.env.folder();
    const offered = this.env.offered?.().length ?? 0;
    const active = this.activeFile(view);
    const path = active?.path ?? null;
    const liveCapable = active?.liveCapable ?? true;
    const hold = path !== null ? model.holdOf(path) : null;
    const vaultKey: unknown[] = [state, this.facts, this.vaultVersion, vault, offered, viewer, linked, this.editing];
    let learnedExpired = false;
    if (this.vaultBuilt !== null) {
      for (const one of this.vaultBuilt.value.learnedProtected) {
        if (model.isLearned?.(one) !== true) {
          learnedExpired = true;
          break;
        }
      }
    }
    const vaultMatches =
      this.vaultBuilt !== null &&
      this.vaultBuilt.key.length === vaultKey.length &&
      this.vaultBuilt.key.every((one, at) => one === vaultKey[at]) &&
      !learnedExpired &&
      !(path !== null && !this.vaultBuilt.value.looseByPath.has(path) && this.vaultBuilt.value.holdById.has(path) && hold !== this.vaultBuilt.value.holdById.get(path));
    let vaultBase: VaultPanelBase;
    if (vaultMatches) {
      vaultBase = this.vaultBuilt!.value;
    } else {
      const both = new Set<string>();
      const views = new Map<string, readonly ("github" | "difference")[]>();
      if (vault) {
        for (const file of vault.files.values()) {
          const compared = comparedOf(file.state);
          if (compared?.kind !== "both") continue;
          if (!compared.baseUnknown && !model.row(file.path)?.entry) both.add(file.path);
          views.set(file.path, viewsOf(compared).flatMap((one) => (one === "github" || one === "difference" ? [one] : [])));
        }
      }
      const toldById = new Map<string, string | null>();
      vaultBase = vaultPanelOf({
        state,
        viewer,
        now: this.now(),
        facts: this.holds.apply(this.facts),
        flight: model.flightAnswer(),
        rooms: model.roomsNow(),
        vaultHas: (one) => model.vaultHas(one),
        docFor: this.env.documentFor,
        holdOf: (one) => model.holdOf(one),
        told: (one) => {
          const words = model.toldWords(one);
          toldById.set(one, words);
          return words;
        },
        both,
        viewsOf: (one) => views.get(one) ?? [],
        newer: vault ? onGitHubFiles(vault) : [],
        heldDeletes: state.heldDeletes?.count ?? 0,
        offered,
        isLive: (one) => this.env.isLive(one),
        isLearned: (one) => model.isLearned?.(one) === true,
        openComments: (one) => this.env.openComments(one),
        mtimeOf: (one) => model.mtimeOf?.(one),
        linked,
        editingGroup: this.editing,
      });
      this.vaultToldById = toldById;
      this.vaultBuilt = { key: vaultKey, value: vaultBase };
    }
    const status = liveCapable ? (view?.state.status ?? null) : null;
    const behind = path !== null && this.behind?.path === path && this.behind.behind;
    const saver = path !== null ? model.saverOf(path) : null;
    const stay = view ? view.state.stay : this.env.stayOn?.() === true;
    const paused = path !== null && this.env.isPaused?.(path) === true;
    const showChanges = path !== null && this.env.since.isOpenFor(path);
    const unchanged = path !== null && !vaultBase.loosePaths.has(path) ? model.unchangedRow(path) : undefined;
    const activeComments = path !== null ? this.env.openComments(path) : 0;
    const readOnly = model.readOnly();
    const plansUrl = this.env.plansUrl();
    const joinKey = this.joinKeyOf(vaultBase);
    this.lastViewMeta = [stay ? "1" : "0", paused ? "1" : "0", hold ?? "", joinKey].join("\0");
    const place = this.env.place();
    if (this.checked === null || this.checkedFor !== place) {
      const stored = this.env.storage.load(CHECKED_KEY(place));
      this.checked = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === "string") : [];
      this.checkedFor = place;
    }
    const githubStatus = this.env.githubStatus?.snapshot() ?? null;
    const activePeople = liveCapable && phaseOf(status) === "local" && (view?.state.people ?? 0) > 0 ? view!.state.people! : 0;
    const activeLearned = path !== null && model.isLearned?.(path) === true;
    const key: unknown[] = [vaultBase, this.version, path, liveCapable, behind, statusSignature(status), activePeople, saverSignature(saver), stay, paused, hold, showChanges, unchangedSignature(unchanged), activeComments, activeLearned, this.checked, this.notice, githubStatus, this.reviewers, readOnly, plansUrl, joinKey];
    if (this.built && this.built.key.length === key.length && this.built.key.every((one, at) => one === key[at])) {
      this.lastView = view;
      return this.built.value;
    }
    const value = panelModelFromVault(vaultBase, {
      state,
      viewer,
      unchanged: (one) => (one === path ? unchanged : model.unchangedRow(one)),
      plansUrl,
      holdOf: (one) => (one === path ? hold : model.holdOf(one)),
      isLive: (one) => this.env.isLive(one),
      ...(stay ? { stay: true } : {}),
      ...(this.env.isPaused ? { isPaused: this.env.isPaused } : {}),
      openComments: (one) => this.env.openComments(one),
      active: path ? { path, status, behind, people: liveCapable ? (view?.state.people ?? null) : null, liveCapable, ...(saver ? { saver } : {}) } : null,
      showChanges,
      checked: this.checked,
      notice: this.notice,
      ...(githubStatus ? { githubStatus } : {}),
      reviewers: this.reviewers,
      readOnly,
      onAction: (action) => this.act(action),
      onChecked: (ids) => this.remember(ids),
    });
    this.units = value.units;
    this.lastView = view;
    this.built = { key, value };
    return value;
  }

  phase(): ChangesPhase {
    return this.env.model.state().phase;
  }

  private remember(ids: readonly string[]): void {
    this.checked = ids;
    this.env.storage.save(CHECKED_KEY(this.checkedFor || this.env.place()), [...ids]);
  }

  get host(): PanelHost {
    return {
      noun: "note",
      openUrl: this.env.note.openUrl,
      ...(this.env.openMenu ? { openMenu: this.env.openMenu } : {}),
      ...(this.env.ask ? { confirm: this.env.ask } : {}),
      ...(this.env.touch ? { touch: true } : {}),
    };
  }

  act(action: PanelAction): Promise<ActionAnswer> {
    const { env } = this;
    const view = this.lastView;
    const ports: StatusPorts = {
      flows: env.flows,
      units: () => this.units,
      active: () => this.activeFile(view)?.path ?? null,
      choice: (path) => env.model.state().choices.get(path),
      ...(env.stayOn ? { stayOn: env.stayOn } : {}),
      inVault: env.inVault,
      openNote: env.note.open,
      openInSpecgit: env.note.openInSpecgit,
      openNoteInSpecgit: (path) => view?.actions.openInSpecgit(path),
      openUrl: env.note.openUrl,
      join: (path) => env.note.join?.(path),
      connect: (path) => view?.actions.connect(path),
      disconnect: (path) => view?.actions.disconnect(path),
      copyLink: (path) => view?.actions.copyLink(path),
      copyIn: env.copyIn,
      moveHeldDeletes: () => env.model.state().heldDeletes?.move(),
      addOffered: () => env.addOffered?.(),
      vaultFile: (path) => env.model.vault()?.files.get(path),
      bringInNewer: env.bringInNewer,
      bringInDraft: env.bringInDraft,
      showSince: (path, on) => {
        if (!on) return env.since.close();
        const row = env.model.row(path);
        if (!row) return;
        env.since.expect(path);
        void env.flows.showRowChanges(row);
      },
      ask: (question) => env.ask?.(question) ?? Promise.resolve(""),
      confirmCatchUp: (row, preview) => this.confirmCatchUp(row, preview),
      editGroup: (id) => {
        this.editing = id;
        this.changed();
      },
      setReviewers: (next) => {
        this.reviewers = next(this.reviewers);
        this.changed(false);
      },
      setNotice: (notice) => {
        this.notice = notice;
        this.changed(false);
      },
      done: (step, id) => this.done(step, id),
      refresh: () => {
        void env.githubStatus?.refresh();
        return env.model.refresh();
      },
      busy: () => env.model.state().busy,
      toast: (title, description) => env.dialogs.toast(title, description),
      notBrought: TRY_AGAIN,
    };
    if (action.type === "submit" || action.type === "approve" || action.type === "publish") {
      this.notice = null;
      this.changed(false);
    }
    return runAction(action, ports);
  }

  private done(step: "submit" | "publish", id: string): boolean {
    const { model } = this.env;
    const state = model.state();
    const row = id.startsWith("g:") ? state.groups.find((card) => `g:${card.group?.id}` === id) : state.rows.find((one) => one.change.path === id);
    if (step === "publish") return row === undefined || state.published.some((one) => one.change.path === id);
    return row?.entry !== null && row?.entry !== undefined && !row.entry.isDraft;
  }

  private async confirmCatchUp(row: ChangeRow, preview: CatchUpPreview | null): Promise<boolean> {
    return this.env.dialogs.confirm(catchUpQuestion(row, preview));
  }
}
