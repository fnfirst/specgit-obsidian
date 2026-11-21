import type { ApiAnswer } from "../api";
import { splitRepo } from "../api";
import { GIT_PROVIDER } from "../auth/config";
import { type LiveEvent, readLiveEvent } from "../shared/review-flow";

export interface LiveEventsDeps {
  api: { call(method: "GET", path: string, input?: { query?: Record<string, string> }): Promise<ApiAnswer> };
  repo(): string;
  signedIn(): boolean;
  hidden(): boolean;
  onWake(cb: () => void): () => void;
  later(run: () => void, ms: number): () => void;
  random?(): number;
}

export const WAIT_S = 25;
export const FIRST_RETRY_MS = 3_000;
export const MAX_RETRY_MS = 60_000;
export const UNSUPPORTED_RETRY_MS = 5 * 60_000;
export const MIN_ASK_GAP_MS = 2_000;
export const RATE_LIMITED_WAIT_MS = 15_000;
export const HUNG_AFTER_MS = (WAIT_S + 15) * 1000;
const LOOK_AGAIN_MS = 30_000;

export class LiveEvents {
  private readonly events = new Set<(event: LiveEvent) => void>();
  private readonly connects = new Set<(reconnected: boolean) => void>();
  private isConnected = false;
  private hadEvents = false;
  private generation = 0;
  private cursor: string | null = null;
  private place = "";
  private failures = 0;
  private askedAt: number | null = null;
  private wake: { end: () => void; byWindow: boolean } | null = null;
  private stops: Array<() => void> = [];

  constructor(private readonly deps: LiveEventsDeps) {}

  connected(): boolean {
    return this.isConnected && (this.askedAt === null || Date.now() - this.askedAt < HUNG_AFTER_MS);
  }

  onEvent(listener: (event: LiveEvent) => void): () => void {
    this.events.add(listener);
    return () => void this.events.delete(listener);
  }

  onConnect(listener: (reconnected: boolean) => void): () => void {
    this.connects.add(listener);
    return () => void this.connects.delete(listener);
  }

  start(): () => void {
    const generation = ++this.generation;
    this.stops.push(this.deps.onWake(() => this.wakeUp(false)));
    void this.run(generation);
    return () => this.stop();
  }

  stop(): void {
    this.generation += 1;
    this.stops.splice(0).forEach((stop) => stop());
    this.setConnected(false);
    this.wakeUp(true);
  }

  settingsChanged(): void {
    this.wakeUp(true);
  }

  private wakeUp(force: boolean): void {
    const wake = this.wake;
    if (!wake || (!force && !wake.byWindow)) return;
    this.wake = null;
    wake.end();
  }

  private sleep(ms: number, generation: number, byWindow = false): Promise<void> {
    return new Promise((resolve) => {
      let cancel = (): void => undefined;
      const done = (): void => {
        cancel();
        if (this.wake?.end === done) this.wake = null;
        resolve();
      };
      this.wake = { end: done, byWindow };
      cancel = this.deps.later(done, ms);
      if (generation !== this.generation) done();
    });
  }

  private setConnected(connected: boolean): void {
    this.isConnected = connected;
  }

  private active(): { owner: string; repo: string } | null {
    const named = splitRepo(this.deps.repo());
    return named && this.deps.signedIn() && !this.deps.hidden() ? named : null;
  }

  private async run(generation: number): Promise<void> {
    while (generation === this.generation) {
      const named = this.active();
      if (!named) {
        this.setConnected(false);
        await this.sleep(LOOK_AGAIN_MS, generation, true);
        continue;
      }
      const place = `${named.owner}/${named.repo}`;
      if (place !== this.place) {
        this.place = place;
        this.cursor = null;
      }
      const startedAt = Date.now();
      this.askedAt = startedAt;
      let answer: ApiAnswer | null = null;
      try {
        answer = await this.deps.api.call("GET", `/api/repos/${GIT_PROVIDER}/${named.owner}/${named.repo}/events`, {
          query: { wait: String(WAIT_S), ...(this.cursor === null ? {} : { after: this.cursor }) },
        });
      } catch {
        answer = null;
      }
      this.askedAt = null;
      if (generation !== this.generation) return;
      if (answer?.status === 429) {
        await this.sleep(RATE_LIMITED_WAIT_MS, generation);
        continue;
      }
      const body = answer?.status === 200 ? answer.body : null;
      const cursor = typeof body?.cursor === "string" ? body.cursor : null;
      if (!answer || !body || cursor === null || !Array.isArray(body.events)) {
        this.setConnected(false);
        if (answer && (answer.status === 404 || answer.status === 403)) {
          this.failures = 0;
          await this.sleep(UNSUPPORTED_RETRY_MS, generation);
          continue;
        }
        const wait = Math.min(FIRST_RETRY_MS * 2 ** this.failures, MAX_RETRY_MS) * (0.75 + (this.deps.random?.() ?? Math.random()) * 0.5);
        this.failures += 1;
        await this.sleep(wait, generation);
        continue;
      }
      this.failures = 0;
      const gap = !this.isConnected && this.hadEvents;
      this.cursor = cursor;
      this.setConnected(true);
      if (body.reset === true || gap) {
        const reconnected = this.hadEvents;
        this.hadEvents = true;
        this.connects.forEach((listener) => listener(reconnected));
      }
      this.hadEvents = true;
      for (const raw of body.events) {
        const event = readLiveEvent(raw);
        if (event) this.events.forEach((listener) => listener(event));
      }
      const early = MIN_ASK_GAP_MS - (Date.now() - startedAt);
      if (early > 0) await this.sleep(early, generation);
    }
  }
}
