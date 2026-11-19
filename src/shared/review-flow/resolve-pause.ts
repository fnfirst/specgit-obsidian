import { RESOLVE_COMMIT_MS, RESOLVE_FADE_MS } from "./comment-rules";

export class ResolvePause {
  private pending: { commit: () => void; cancel: () => void } | null = null;

  constructor(private readonly after: (run: () => void, ms: number) => () => void) {}

  get waiting(): boolean {
    return this.pending !== null;
  }

  start(steps: { fade: () => void; commit: () => void }): void {
    if (this.pending) return;
    const cancels = [this.after(steps.fade, RESOLVE_FADE_MS), this.after(() => this.flush(), RESOLVE_COMMIT_MS)];
    this.pending = {
      commit: steps.commit,
      cancel: () => cancels.forEach((cancel) => cancel()),
    };
  }

  flush(): void {
    const { pending } = this;
    if (!pending) return;
    this.pending = null;
    pending.cancel();
    pending.commit();
  }
}
