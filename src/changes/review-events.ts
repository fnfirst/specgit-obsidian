import type { LiveEvent } from "../shared/review-flow";

export const REVIEW_EVENT_MEMORY_MS = 30_000;

export class ReviewEvents {
  private heard_: Array<{ at: number; used: boolean; branch?: string; pr?: number }> = [];
  private lost = false;

  heard(event: LiveEvent, now: number): void {
    if (event.kind !== "review" || event.push === true) return;
    this.heard_.push({ at: now, used: false, ...(event.branch === undefined ? {} : { branch: event.branch }), ...(event.pr === undefined ? {} : { pr: event.pr }) });
  }

  named(now: number): { branches: ReadonlySet<string>; prs: ReadonlySet<number> } | undefined {
    for (const one of this.heard_) if (now - one.at >= REVIEW_EVENT_MEMORY_MS && !one.used) this.lost = true;
    this.heard_ = this.heard_.filter((one) => now - one.at < REVIEW_EVENT_MEMORY_MS);
    const lost = this.lost;
    this.lost = false;
    if (lost) this.heard_ = [];
    if (lost || this.heard_.length === 0 || this.heard_.some((one) => one.branch === undefined && one.pr === undefined)) return undefined;
    for (const one of this.heard_) one.used = true;
    return { branches: new Set(this.heard_.flatMap((one) => (one.branch === undefined ? [] : [one.branch]))), prs: new Set(this.heard_.flatMap((one) => (one.pr === undefined ? [] : [one.pr]))) };
  }
}
