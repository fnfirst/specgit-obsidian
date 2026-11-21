import { IDLE_AFTER_MS, IDLE_FOCUSED_AFTER_MS, type PollSignals } from "../shared/review-flow";

export const CHECK_EVERY_MS = 20_000;
export const QUIET_MS = 5 * 60_000;

export function restingSignals(signals: PollSignals, stayOn: () => boolean): PollSignals {
  return { ...signals, lastActivityAt: () => (stayOn() && !signals.hidden() ? signals.now() : signals.lastActivityAt()) };
}

export interface WatchDeps {
  signals: PollSignals;
  moved(): Promise<boolean>;
  live(): boolean;
  look(): void;
  stay?(): boolean;
}

export class Watch {
  private wait = CHECK_EVERY_MS;
  private nextAt = 0;
  private seen = "";
  private checking = false;

  constructor(private readonly deps: WatchDeps) {}

  unquiet(): void {
    this.wait = CHECK_EVERY_MS;
    this.nextAt = 0;
  }

  looked(signature: string): void {
    this.wait = this.deps.live() ? QUIET_MS : signature === this.seen ? Math.min(this.wait * 2, QUIET_MS) : CHECK_EVERY_MS;
    this.seen = signature;
    this.nextAt = this.deps.signals.now() + this.wait;
  }

  private inUse(): boolean {
    const { signals } = this.deps;
    if (signals.hidden()) return false;
    return signals.now() - signals.lastActivityAt() < (signals.focused?.() ? IDLE_FOCUSED_AFTER_MS : IDLE_AFTER_MS);
  }

  async tick(): Promise<void> {
    if (!this.inUse()) {
      if (this.deps.stay?.() === true && !this.deps.signals.hidden() && this.deps.signals.now() >= this.nextAt) this.deps.look();
      return;
    }
    if (this.checking) return;
    this.checking = true;
    try {
      const moved = await this.deps.moved();
      if (moved) this.unquiet();
      if (moved || this.deps.signals.now() >= this.nextAt) this.deps.look();
    } finally {
      this.checking = false;
    }
  }
}
