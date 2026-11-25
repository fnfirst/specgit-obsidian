export const SIGNED_IN_CACHE_MS = 5_000;

export class SignedInCache {
  private cached: { value: boolean; at: number } | null = null;

  constructor(
    private readonly read: () => boolean,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SIGNED_IN_CACHE_MS,
  ) {}

  isSignedIn(): boolean {
    const at = this.now();
    if (this.cached !== null && at - this.cached.at < this.ttlMs) return this.cached.value;
    const value = this.read();
    this.cached = { value, at };
    return value;
  }

  invalidate(): void {
    this.cached = null;
  }
}
