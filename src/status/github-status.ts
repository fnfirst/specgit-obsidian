import {
  combineGithubStatus,
  GITHUB_STATUS_PAGE_URL,
  isGithubAffected,
  isGithubStatusSnapshot,
  OPERATIONAL_GITHUB_STATUS,
  type GithubComponentKey,
  type GithubStatusSnapshot,
} from "../shared/review-flow";
import type { SpecgitApi } from "../api";

export const GITHUB_STATUS_THROTTLE_MS = 60_000;
export const GITHUB_STATUS_PATH = "/api/status/github";

type FeedSnapshot = Omit<GithubStatusSnapshot, "circuit" | "retryAfterSec">;

export interface GithubStatusReader {
  snapshot: () => GithubStatusSnapshot | null;
  refresh: (options?: { force?: boolean }) => Promise<GithubStatusSnapshot | null>;
  noteFastFail: (retryAfterMs?: number) => void;
  noteHealthy: () => void;
  subscribe: (listener: () => void) => () => void;
  onRecover: (listener: () => void) => () => void;
}

export interface GithubStatusDeps {
  api: Pick<SpecgitApi, "call">;
  signedIn: () => boolean;
  now?: () => number;
}

const COMPONENT_KEYS: readonly GithubComponentKey[] = ["api", "git", "pull_requests", "issues", "webhooks"];

function sameSnapshot(a: GithubStatusSnapshot | null, b: GithubStatusSnapshot | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (
    a.state !== b.state ||
    a.source !== b.source ||
    a.circuit !== b.circuit ||
    a.retryAfterSec !== b.retryAfterSec ||
    a.webhooksOnly !== b.webhooksOnly ||
    a.incidentName !== b.incidentName ||
    a.statusUrl !== b.statusUrl
  ) {
    return false;
  }
  for (const key of COMPONENT_KEYS) {
    if (a.components[key] !== b.components[key]) return false;
  }
  return true;
}

function feedPartOf(snapshot: GithubStatusSnapshot): FeedSnapshot {
  return {
    state: snapshot.state,
    source: "feed",
    components: snapshot.components,
    webhooksOnly: snapshot.webhooksOnly,
    incidentName: snapshot.incidentName,
    statusUrl: snapshot.statusUrl,
    updatedAt: snapshot.updatedAt,
  };
}

export class GithubStatusTracker implements GithubStatusReader {
  private current: GithubStatusSnapshot | null = null;
  private lastFeed: FeedSnapshot | null = null;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private fastFailEpoch = 0;
  private inflight: Promise<GithubStatusSnapshot | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly recoveryListeners = new Set<() => void>();
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly deps: GithubStatusDeps) {
    this.now = deps.now ?? Date.now;
  }

  snapshot(): GithubStatusSnapshot | null {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  onRecover(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => void this.recoveryListeners.delete(listener);
  }

  apply(next: GithubStatusSnapshot): void {
    if (this.disposed) return;
    if (next.source === "feed") this.lastFeed = feedPartOf(next);
    else if (next.source === "both") this.lastFeed = this.lastFeed ?? feedPartOf(next);
    else if (next.source === "none") this.lastFeed = null;
    this.setSnapshot(next);
  }

  noteFastFail(retryAfterMs?: number): void {
    if (this.disposed) return;
    this.fastFailEpoch += 1;
    const retryAfterSec =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.max(1, Math.ceil(retryAfterMs / 1000))
        : null;
    const next = combineGithubStatus(this.lastFeed, { degraded: true, circuit: "open", retryAfterSec }, this.now());
    this.setSnapshot(next);
  }

  noteHealthy(): void {
    if (this.disposed) return;
    const prev = this.current;
    if (prev === null) return;
    if (prev.source === "observed" || (prev.source === "none" && prev.circuit !== "closed")) {
      this.setSnapshot({ ...OPERATIONAL_GITHUB_STATUS, statusUrl: GITHUB_STATUS_PAGE_URL, updatedAt: this.now() });
      return;
    }
    if (prev.source === "both") {
      const next = combineGithubStatus(this.lastFeed, { degraded: false, circuit: "closed", retryAfterSec: null }, this.now());
      this.setSnapshot(next);
      void this.refresh();
      return;
    }
    if (prev.source === "feed" && prev.state !== "operational") {
      void this.refresh();
    }
  }

  refresh(options?: { force?: boolean }): Promise<GithubStatusSnapshot | null> {
    if (this.disposed || !this.deps.signedIn()) return Promise.resolve(this.current);
    if (this.inflight !== null) return this.inflight;
    const at = this.now();
    if (!options?.force && at - this.lastFetchAt < GITHUB_STATUS_THROTTLE_MS) {
      return Promise.resolve(this.current);
    }
    this.lastFetchAt = at;
    const epoch = this.fastFailEpoch;
    const run = (async (): Promise<GithubStatusSnapshot | null> => {
      try {
        const answer = await this.deps.api.call("GET", GITHUB_STATUS_PATH);
        if (this.disposed || !this.deps.signedIn()) return this.current;
        if (answer.status === 200 && isGithubStatusSnapshot(answer.body)) {
          if (this.fastFailEpoch === epoch || isGithubAffected(answer.body)) {
            this.apply(answer.body);
          }
        }
      } catch {
        return this.current;
      }
      return this.current;
    })().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  reset(): void {
    this.fastFailEpoch += 1;
    this.lastFeed = null;
    this.lastFetchAt = Number.NEGATIVE_INFINITY;
    if (this.current === null) return;
    this.current = null;
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.recoveryListeners.clear();
  }

  private setSnapshot(next: GithubStatusSnapshot): void {
    const prev = this.current;
    if (sameSnapshot(prev, next)) return;
    const wasAffected = isGithubAffected(prev);
    this.current = next;
    this.emit();
    if (wasAffected && !isGithubAffected(next)) this.emitRecovery();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  private emitRecovery(): void {
    this.recoveryListeners.forEach((listener) => listener());
  }
}
