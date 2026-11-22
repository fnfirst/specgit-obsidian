export const WAKE_PAD_MS = 50;

export class WakeClock {
  private ms: number | null = null;

  reset(): void {
    this.ms = null;
  }

  at(delayMs: number): void {
    const padded = Math.max(0, delayMs) + WAKE_PAD_MS;
    this.ms = this.ms === null ? padded : Math.min(this.ms, padded);
  }

  until(timestampMs: number, now: number): void {
    this.at(timestampMs - now);
  }

  value(): number | null {
    return this.ms;
  }
}

export class BackoffWaits<T = undefined> {
  private readonly entries = new Map<string, { until: number; strikes: number; tag: T }>();

  constructor(
    private readonly now: () => number,
    private readonly delayFor: (strikes: number) => number,
  ) {}

  waiting(key: string, tag: T, wake: WakeClock): boolean {
    const entry = this.entries.get(key);
    const now = this.now();
    if (!entry || entry.tag !== tag || now >= entry.until) return false;
    wake.until(entry.until, now);
    return true;
  }

  defer(key: string, tag: T, wake: WakeClock, overrideMs?: number): void {
    const before = this.entries.get(key);
    const strikes = before && before.tag === tag ? before.strikes + 1 : 0;
    const delay = overrideMs ?? this.delayFor(strikes);
    this.entries.set(key, { strikes, until: this.now() + delay, tag });
    wake.at(delay);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
