import { timeout } from "./timer";

export const LIVE_EVENT_KINDS = ["threads", "review", "main", "access", "presence"] as const;
export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];

export interface LiveEvent {
  kind: LiveEventKind;

  branch?: string;

  path?: string;

  pr?: number;

  push?: true;

  sha?: string;
}

export function parseLiveEvent(raw: string): LiveEvent | null {
  try {
    return readLiveEvent(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readLiveEvent(value: unknown): LiveEvent | null {
  const event = value as Partial<LiveEvent> | null;
  if (typeof event !== "object" || event === null || !LIVE_EVENT_KINDS.includes(event.kind as LiveEventKind)) return null;
  const text = (field: unknown): string | undefined => (typeof field === "string" && field !== "" ? field : undefined);

  if (event.kind === "presence") return { kind: "presence" };
  return {
    kind: event.kind as LiveEventKind,
    ...(text(event.branch) ? { branch: text(event.branch) } : {}),
    ...(text(event.path) ? { path: text(event.path) } : {}),
    ...(typeof event.pr === "number" && Number.isInteger(event.pr) && event.pr > 0 ? { pr: event.pr } : {}),
    ...(event.push === true ? { push: true as const } : {}),
    ...(typeof event.sha === "string" && /^[0-9a-f]{40}$/.test(event.sha) ? { sha: event.sha } : {}),
  };
}

export function concernsDocument(event: LiveEvent, path: string): boolean {
  return event.kind === "threads" && (event.path === undefined || event.path === path);
}

export const LIVE_SETTLE_MS = 400;

export const LIVE_PUSH_SETTLE_MS = 10_000;

export const LIVE_RECHECK_MS = 4_000;

export const RETURN_SECOND_READ_MS = 4_000;

export const LIVE_ECHO_MS = 2_000;

export const LIVE_CATCH_UP_FLOOR_MS = 5_000;

export interface SettleDeps {

  later?: (run: () => void, ms: number) => () => void;
}

export class SettledReload {
  private stopRead: (() => void) | null = null;
  private stopRecheck: (() => void) | null = null;
  private readAt = 0;
  private readKey = "";
  private readonly later: (run: () => void, ms: number) => () => void;

  constructor(
    private readonly run: (recheck: boolean) => void,
    private readonly options: { settleMs?: number; recheckMs?: number | null } & SettleDeps = {},
  ) {
    this.later = options.later ?? timeout;
  }

  get pending(): boolean {
    return this.stopRead !== null || this.stopRecheck !== null;
  }

  heard(key = ""): boolean {
    if (this.stopRecheck !== null && key === this.readKey && Date.now() - this.readAt < LIVE_ECHO_MS) {

      this.stopRecheck();
      this.stopRecheck = this.later(() => {
        this.stopRecheck = null;
        this.run(true);
      }, this.options.recheckMs ?? LIVE_RECHECK_MS);
      return true;
    }
    this.stop();
    this.readKey = key;
    this.stopRead = this.later(() => {
      this.stopRead = null;
      this.readAt = Date.now();
      this.run(false);
      const recheck = this.options.recheckMs === undefined ? LIVE_RECHECK_MS : this.options.recheckMs;
      if (recheck !== null) {
        this.stopRecheck = this.later(() => {
          this.stopRecheck = null;
          this.run(true);
        }, recheck);
      }
    }, this.options.settleMs ?? LIVE_SETTLE_MS);
    return false;
  }

  heardOnce(key = ""): void {
    if (!this.pending) this.heard(key);
  }

  stop(): void {
    this.stopRead?.();
    this.stopRecheck?.();
    this.stopRead = null;
    this.stopRecheck = null;
  }
}

export interface ReactionSignals {
  hidden(): boolean;

  idle?(): boolean;
  onShown(cb: () => void): () => void;
  onFocused?(cb: () => void): () => void;

  onActive?(cb: () => void): () => void;
}

export interface EventReading {
  kinds: ReadonlySet<LiveEventKind>;
  push: boolean;

  recheck: boolean;

  expireReviews: boolean;
}
export type EventRead = (reading: EventReading) => void;

const expiresReviews = (kinds: ReadonlySet<LiveEventKind>, push: boolean): boolean => kinds.has("review") && !push;

export class EventReload {
  private readonly settled: SettledReload;
  private readonly pushes: SettledReload;

  private cycle: { kinds: Set<LiveEventKind>; push: boolean; late: boolean } = { kinds: new Set(), push: true, late: false };

  private owed: { kinds: Set<LiveEventKind>; push: boolean } | null = null;
  private caughtUpAt = Number.NEGATIVE_INFINITY;
  private readonly later: (run: () => void, ms: number) => () => void;

  private stopSecond: (() => void) | null = null;

  constructor(
    private readonly read: EventRead,
    private readonly signals: ReactionSignals,
    deps: SettleDeps = {},
  ) {
    this.later = deps.later ?? timeout;
    this.settled = new SettledReload((recheck) => this.fire(recheck), deps);
    this.pushes = new SettledReload((recheck) => this.fire(recheck), { ...deps, settleMs: LIVE_PUSH_SETTLE_MS, recheckMs: null });
  }

  private resting(): boolean {
    return this.signals.hidden() || this.signals.idle?.() === true;
  }

  owes(): boolean {
    return this.owed !== null;
  }

  paid(): void {
    this.owed = null;
  }

  private fire(recheck: boolean): void {
    const { kinds, push, late } = this.cycle;
    this.read({ kinds: new Set(kinds), push, recheck, expireReviews: expiresReviews(kinds, push) && (!recheck || late) });
  }

  private note(event: LiveEvent, into: { kinds: Set<LiveEventKind>; push: boolean }): void {
    into.kinds.add(event.kind);
    if (!event.push) into.push = false;
  }

  heard(event: LiveEvent): void {
    if (this.resting()) {
      this.owed ??= { kinds: new Set(), push: true };
      this.note(event, this.owed);
      return;
    }
    if (!this.settled.pending && !this.pushes.pending) this.cycle = { kinds: new Set(), push: true, late: false };
    this.note(event, this.cycle);
    const key = `${event.kind}|${event.pr ?? ""}`;
    if (event.push) this.pushes.heardOnce(key);

    else if (this.settled.heard(key) && event.kind === "review") this.cycle.late = true;
  }

  catchUp(first = false): void {
    if (this.resting()) {
      this.owed ??= { kinds: new Set(), push: true };
      this.owed.push = false;
      return;
    }
    const now = Date.now();
    if (first && now - this.caughtUpAt < LIVE_CATCH_UP_FLOOR_MS) return;
    this.caughtUpAt = now;
    this.read({ kinds: new Set(), push: false, recheck: false, expireReviews: false });
  }

  start(): () => void {
    const pay = (): void => {
      if (!this.owed || this.resting()) return;
      const owed = this.owed;
      this.owed = null;
      this.read({ kinds: owed.kinds, push: owed.push, recheck: false, expireReviews: expiresReviews(owed.kinds, owed.push) });

      this.stopSecond?.();
      this.stopSecond = this.later(() => {
        this.stopSecond = null;
        if (!this.signals.hidden()) this.read({ kinds: owed.kinds, push: owed.push, recheck: true, expireReviews: false });
      }, RETURN_SECOND_READ_MS);
    };
    const stops = [this.signals.onShown(pay), this.signals.onFocused?.(pay), this.signals.onActive?.(pay)];
    return () => {
      stops.forEach((stop) => stop?.());
      this.stop();
    };
  }

  stop(): void {
    this.settled.stop();
    this.pushes.stop();
    this.stopSecond?.();
    this.stopSecond = null;
    this.owed = null;
  }
}
