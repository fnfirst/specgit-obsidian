import { CATCH_UP, type CatchUpPreview, isViewersBranch, TRY_AGAIN } from "../shared/review-flow";
import type { ActionAnswer, PanelAction, PanelHost, ReviewFacts, StatusNotice, StatusReviewer } from "../shared/status-panel";
import { comparedOf, onGitHubFiles } from "../changes/vault-state";
import { type Built, panelModelOf } from "./panel-model";
import { runAction, type StatusFlows, type StatusPorts } from "./panel-actions";
import type { ChangeRow, ChangesModel, ChangesPhase } from "../changes/model";
import type { Dialogs } from "../changes/flow-deps";
import type { PanelState } from "../panel/model";
import type { PanelActions } from "../panel/panel";
import type { ReviewApi } from "../review/review-api";
import { factsOf } from "../review/review-api";
import { CATCH_UP_HERE } from "../review/words";
import { viewsOf } from "../changes/vault-since";
import { type DocumentRef, noteName } from "../mapping";
import type { BroughtDraft } from "../changes/bring-in";
import { DraftHold, HELD_RECHECK_MS } from "./draft-hold";

export const FACTS_PER_REQUEST = 50;
export const FACTS_FRESH_MS = 30_000;
export const FACTS_RETRY_MS = 15_000;
export const FACTS_RETRY_MAX_MS = 120_000;
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
  now?: () => number;
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
  private readAt = 0;
  private retry: unknown = null;
  private retryMs = FACTS_RETRY_MS;
  private limitedUntil = 0;
  private fullRefreshPending = false;
  private pendingRefresh = new Set<number>();
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
  private built: { key: unknown[]; value: Built } | null = null;
  private lastView: StatusView | null = null;
  private units: Built["units"] = { rows: new Map(), members: new Map(), urls: new Map() };
  private disposed = false;
  private readonly stops: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly env: StatusEnv) {
    this.now = env.now ?? Date.now;
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
    this.stops.push(env.since.subscribe(() => this.changed()));
  }

  dispose(): void {
    this.disposed = true;
    this.limitedUntil = 0;
    this.fullRefreshPending = false;
    this.pendingRefresh.clear();
    this.cancelRetry();
    this.holds.clear();
    this.stops.forEach((stop) => stop());
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private changed(): void {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  private numbers(): number[] {
    const { rows, groups } = this.env.model.state();
    const found = new Set<number>();
    for (const row of rows) if (row.entry && row.entry.prNumber > 0) found.add(row.entry.prNumber);
    for (const card of groups) if (card.group && card.group.overview.prNumber > 0) found.add(card.group.overview.prNumber);
    for (const entries of Object.values(this.env.model.flightAnswer()?.paths ?? {})) for (const one of entries) if (one.prNumber !== undefined && one.prNumber > 0) found.add(one.prNumber);
    return [...found].sort((a, b) => a - b);
  }

  private ordered(): number[] {
    const { rows, groups } = this.env.model.state();
    const own = new Set<number>();
    for (const row of rows) if (row.entry && row.entry.prNumber > 0) own.add(row.entry.prNumber);
    for (const card of groups) if (card.group && card.group.overview.prNumber > 0) own.add(card.group.overview.prNumber);
    const viewer = this.env.viewer();
    for (const entries of Object.values(this.env.model.flightAnswer()?.paths ?? {})) for (const one of entries) if (one.prNumber !== undefined && one.prNumber > 0 && isViewersBranch(one, viewer)) own.add(one.prNumber);
    const all = this.numbers();
    return [...all.filter((number) => own.has(number)), ...all.filter((number) => !own.has(number))];
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

  private scheduleRetry(wait: number): void {
    this.cancelRetry();
    const run = (): void => {
      this.retry = null;
      if (this.disposed) return;
      void this.read(true);
    };
    this.retry = this.setTimer(run, wait);
  }

  private retryLater(): void {
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, FACTS_RETRY_MAX_MS);
    this.scheduleRetry(wait);
  }

  private syncRepo(): void {
    const repo = this.env.repo();
    if (this.factsFor === repo) return;
    this.factsFor = repo;
    this.facts = new Map();
    this.asked = "";
    this.readAt = 0;
    this.limitedUntil = 0;
    this.fullRefreshPending = false;
    this.pendingRefresh.clear();
    this.cancelRetry();
    this.holds.clear();
  }

  holdDraft(prNumber: number, isDraft: boolean, requestedReviewers?: readonly string[]): void {
    if (this.disposed) return;
    this.syncRepo();
    if (this.holds.record(prNumber, isDraft, ++this.seq, this.facts, this.reading !== null, requestedReviewers)) this.changed();
  }

  private modelChanged(): void {
    if (this.disposed) return;
    const { busy } = this.env.model.state();
    const ended = this.wasBusy && !busy;
    this.wasBusy = busy;
    if (ended || this.numbers().join(",") !== this.asked) void this.read();
    this.preview();
    this.changed();
  }

  private look(): void {
    if (this.disposed) return;
    if (this.numbers().join(",") !== this.asked || this.now() - this.readAt >= FACTS_FRESH_MS) void this.read();
  }

  reviewsChanged(): void {
    if (this.disposed) return;
    void this.read();
  }

  private read(retrying = false, only?: readonly number[]): Promise<void> {
    this.syncRepo();
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
    const numbers = this.ordered();
    let wanted: number[];
    if (only) {
      const targets = new Set(only);
      wanted = numbers.filter((number) => targets.has(number));
      if (wanted.length === 0) return Promise.resolve();
    } else {
      this.asked = this.numbers().join(",");
      this.readAt = this.now();
      const full = !retrying || this.fullRefreshPending;
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
      let limited: { limited: true; retryAfterMs?: number } | null = null;
      let stoppedAt = wanted.length;
      for (let at = 0; at < wanted.length; at += FACTS_PER_REQUEST) {
        const answer = await this.env.review.details(repo, wanted.slice(at, at + FACTS_PER_REQUEST));
        if (this.disposed || this.env.repo() !== repo) return;
        if (!(answer instanceof Map)) {
          complete = false;
          stoppedAt = at;
          if (answer === "failed") refused = true;
          else if (answer !== null) limited = answer;
          break;
        }
        for (const [number, detail] of answer) next.set(number, factsOf(detail));
      }
      if (this.disposed || this.env.repo() !== repo) return;
      if (complete) {
        this.retryMs = FACTS_RETRY_MS;
        this.limitedUntil = 0;
      } else if (limited !== null || refused) {
        for (const number of wanted.slice(stoppedAt)) this.pendingRefresh.add(number);
        if (limited !== null) {
          const wait = limited.retryAfterMs ?? this.retryMs;
          if (limited.retryAfterMs === undefined) this.retryMs = Math.min(this.retryMs * 2, FACTS_RETRY_MAX_MS);
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
    const key = `${path}|${row.entry.prNumber}|${row.change.sha}`;
    if (key === this.previewing) return;
    this.previewing = key;
    void this.env.flows.preview(row.doc).then((answer: CatchUpPreview | null) => {
      if (this.disposed || this.previewing !== key) return;
      this.behind = { path, blob: answer?.kind === "behind" ? answer.mainBlob : "", behind: answer?.kind === "behind" };
      this.changed();
    });
  }

  private shownPath(view: StatusView | null): string | null {
    return view ? (view.state.note?.path ?? null) : this.env.activePath();
  }

  unchangedPath(view: StatusView | null): string | null {
    const path = this.shownPath(view);
    return path !== null && !this.env.model.row(path) ? path : null;
  }

  unreadPath(view: StatusView | null): string | null {
    const path = this.shownPath(view);
    const row = path === null ? undefined : this.env.model.row(path);
    return row && (row.unread || row.light) ? row.change.path : null;
  }

  readRow(path: string | null): void {
    const row = path === null ? undefined : this.env.model.row(path);
    if (row) void this.env.model.read([row]);
  }

  watchUnchanged(path: string | null): () => void {
    this.env.model.watchUnchanged(path);
    return () => this.env.model.watchUnchanged(null);
  }

  build(view: StatusView | null): Built {
    const { model } = this.env;
    this.syncRepo();
    if (this.holds.reconcile(this.facts)) this.version++;
    const state = model.state();
    const path = view ? (view.state.note?.path ?? null) : this.env.activePath();
    const status = view?.state.status ?? null;
    const behind = path !== null && this.behind?.path === path && this.behind.behind;
    const stay = view ? view.state.stay : this.env.stayOn?.() === true;
    const paused = path !== null && this.env.isPaused?.(path) === true;
    const hold = path !== null ? model.holdOf(path) : null;
    const key: unknown[] = [state, this.facts, this.version, view?.state ?? null, path, behind, status, model.vault(), stay, paused, hold];
    if (this.built && this.built.key.length === key.length && this.built.key.every((one, at) => one === key[at])) return this.built.value;
    const both = new Set<string>();
    const views = new Map<string, readonly ("github" | "difference")[]>();
    const vault = model.vault();
    if (vault) {
      for (const file of vault.files.values()) {
        const compared = comparedOf(file.state);
        if (compared?.kind !== "both") continue;
        if (!compared.baseUnknown && !model.row(file.path)?.entry) both.add(file.path);
        views.set(file.path, viewsOf(compared).flatMap((view) => (view === "github" || view === "difference" ? [view] : [])));
      }
    }
    const place = this.env.place();
    if (this.checked === null || this.checkedFor !== place) {
      const stored = this.env.storage.load(CHECKED_KEY(place));
      this.checked = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === "string") : [];
      this.checkedFor = place;
    }
    const value = panelModelOf({
      state,
      viewer: this.env.viewer(),
      now: this.now(),
      facts: this.holds.apply(this.facts),
      flight: model.flightAnswer(),
      rooms: model.roomsNow(),
      unchanged: (one) => model.unchangedRow(one),
      vaultHas: (one) => model.vaultHas(one),
      docFor: this.env.documentFor,
      plansUrl: this.env.plansUrl(),
      holdOf: (one) => model.holdOf(one),
      told: (one) => model.toldWords(one),
      both,
      viewsOf: (one) => views.get(one) ?? [],
      newer: vault ? onGitHubFiles(vault) : [],
      heldDeletes: state.heldDeletes?.count ?? 0,
      offered: this.env.offered?.().length ?? 0,
      isLive: (one) => this.env.isLive(one),
      ...(stay ? { stay: true } : {}),
      ...(this.env.isPaused ? { isPaused: this.env.isPaused } : {}),
      openComments: (one) => this.env.openComments(one),
      linked: this.env.folder(),
      active: path ? { path, status, behind, people: view?.state.people ?? null } : null,
      showChanges: path !== null && this.env.since.isOpenFor(path),
      checked: this.checked,
      notice: this.notice,
      editingGroup: this.editing,
      reviewers: this.reviewers,
      readOnly: model.readOnly(),
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
    return { noun: "note", ...(this.env.openMenu ? { openMenu: this.env.openMenu } : {}), ...(this.env.ask ? { confirm: this.env.ask } : {}), ...(this.env.touch ? { touch: true } : {}) };
  }

  act(action: PanelAction): Promise<ActionAnswer> {
    const { env } = this;
    const view = this.lastView;
    const ports: StatusPorts = {
      flows: env.flows,
      units: () => this.units,
      active: () => view?.state.note?.path ?? env.activePath(),
      choice: (path) => env.model.state().choices.get(path),
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
        this.changed();
      },
      setNotice: (notice) => {
        this.notice = notice;
        this.changed();
      },
      done: (step, id) => this.done(step, id),
      refresh: () => env.model.refresh(),
      busy: () => env.model.state().busy,
      toast: (title, description) => env.dialogs.toast(title, description),
      notBrought: TRY_AGAIN,
    };
    if (action.type === "submit" || action.type === "approve" || action.type === "publish") {
      this.notice = null;
      this.changed();
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
