export const BRIDGE_ASK_WAITS_MS: readonly number[] = [8_000, 2_000, 5_000, 10_000, 10_000, 10_000, 10_000, 10_000, 60_000];

export const LEAVE_WAIT_MIN_MS = 500;
export const LEAVE_WAIT_MAX_MS = 5_000;

const MOST_TOLD_S = 600;

function waitFrom(answer: unknown): number {
  const seconds = typeof answer === "object" && answer !== null ? (answer as { bridgeWaitSeconds?: unknown }).bridgeWaitSeconds : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MOST_TOLD_S) * 1000 : 0;
}

const JITTER = 0.25;

export class BridgeRequests {
  private timer: number | null = null;
  private asking = false;
  private wanted = false;
  private tries = 0;
  private stopped = false;
  private told = 0;

  constructor(
    private readonly ask: () => Promise<unknown>,
    private readonly random: () => number = () => Math.random(),
  ) {}

  missing(missing: boolean): void {
    if (this.stopped) return;
    this.wanted = missing;
    if (!missing) {
      this.clear();
      this.tries = 0;
    } else this.wait();
  }

  leftOnPurpose(): void {
    if (this.stopped || !this.wanted || this.asking) return;
    this.clear();
    this.timer = window.setTimeout(() => void this.run(), LEAVE_WAIT_MIN_MS + (LEAVE_WAIT_MAX_MS - LEAVE_WAIT_MIN_MS) * this.random());
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private wait(): void {
    if (this.stopped || !this.wanted || this.timer !== null || this.asking) return;
    const base = BRIDGE_ASK_WAITS_MS[Math.min(this.tries, BRIDGE_ASK_WAITS_MS.length - 1)] ?? 0;
    this.timer = window.setTimeout(() => void this.run(), Math.max(base * (1 - JITTER + 2 * JITTER * this.random()), this.told));
  }

  private async run(): Promise<void> {
    this.timer = null;
    this.asking = true;
    this.tries++;
    this.told = 0;
    try {
      this.told = waitFrom(await this.ask());
    } catch {
      void 0;
    } finally {
      this.asking = false;
    }
    this.wait();
  }
}
