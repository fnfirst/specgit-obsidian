import { IDLE_AFTER_MS, IDLE_FOCUSED_AFTER_MS, type PollSignals } from "../shared/review-flow";
import type { Looked } from "./model";

export const CHECK_EVERY_MS = 20_000;
export const POST_START_RECHECK_MS = 30_000;
export const QUIET_MS = 5 * 60_000;

export function restingSignals(signals: PollSignals, stayOn: () => boolean): PollSignals {
  return { ...signals, lastActivityAt: () => (stayOn() && !signals.hidden() ? signals.now() : signals.lastActivityAt()) };
}

export function watchSignature(looked: Looked | null): string {
  if (looked === null) return "off";
  const rows = looked.rows.map((row) => `${row.change.path}:${row.change.sha}:${row.entry?.prNumber ?? 0}:${row.entry?.isDraft ?? ""}`).join(",");
  const drafts = [...(looked.drafts?.byPath ?? [])]
    .map(([path, draft]) => `${path}:${draft.blob ?? ""}`)
    .sort()
    .join(",");
  return `${looked.repo.size}|${rows}|${drafts}`;
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
  private checkWait = CHECK_EVERY_MS;
  private nextCheckAt = 0;
  private seen = "";
  private checking = false;
  private recheck: "armed" | number | null = null;

  constructor(private readonly deps: WatchDeps) {}

  unquiet(): void {
    this.wait = CHECK_EVERY_MS;
    this.nextAt = 0;
    this.checkWait = CHECK_EVERY_MS;
    this.nextCheckAt = 0;
    this.recheck = this.deps.stay?.() === true ? "armed" : null;
  }

  looked(signature: string): void {
    const now = this.deps.signals.now();
    const moved = this.seen !== "" && signature !== this.seen;
    this.wait = this.deps.live() ? QUIET_MS : signature === this.seen ? Math.min(this.wait * 2, QUIET_MS) : CHECK_EVERY_MS;
    this.seen = signature;
    this.nextAt = now + this.wait;
    if (this.deps.stay?.() !== true || moved) {
      this.recheck = null;
      return;
    }
    if (this.recheck === "armed") this.recheck = this.wait > POST_START_RECHECK_MS ? now + POST_START_RECHECK_MS : null;
    else if (typeof this.recheck === "number" && now >= this.recheck) this.recheck = null;
    if (typeof this.recheck === "number") this.nextAt = Math.min(this.nextAt, this.recheck);
  }

  private inUse(): boolean {
    const { signals } = this.deps;
    if (signals.hidden()) return false;
    return signals.now() - signals.lastActivityAt() < (signals.focused?.() ? IDLE_FOCUSED_AFTER_MS : IDLE_AFTER_MS);
  }

  private triggerLook(now: number): void {
    if (typeof this.recheck === "number" && now >= this.recheck) {
      this.recheck = null;
      this.nextAt = now + this.wait;
    }
    this.deps.look();
  }

  async tick(): Promise<void> {
    const now = this.deps.signals.now();
    if (!this.inUse()) {
      if (this.deps.stay?.() === true && !this.deps.signals.hidden() && now >= this.nextAt) this.triggerLook(now);
      return;
    }
    if (this.checking) return;
    const backoff = this.deps.live() || this.deps.stay?.() === true;
    if (backoff && now < this.nextCheckAt) {
      if (now >= this.nextAt) this.triggerLook(now);
      return;
    }
    this.checking = true;
    try {
      const moved = await this.deps.moved();
      const after = this.deps.signals.now();
      if (moved) this.unquiet();
      else if (backoff) {
        this.nextCheckAt = after + this.checkWait;
        this.checkWait = Math.min(this.checkWait * 2, QUIET_MS);
      } else {
        this.checkWait = CHECK_EVERY_MS;
        this.nextCheckAt = 0;
      }
      if (moved || after >= this.nextAt) this.triggerLook(after);
    } finally {
      this.checking = false;
    }
  }
}
