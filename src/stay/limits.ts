import { MIN_RETRY_AFTER_MS } from "../api/retry-after";
import type { LocalState } from "../disk/bases";
import { hashText } from "../hash";

export { MIN_RETRY_AFTER_MS };

export interface BudgetRecord {
  spent: Array<[number, number]>;
  backoff: { until: number; strikes: number } | null;
}

const BUDGET_KEY = "specgit-stay-budget";

function readRecord(storage: LocalState, key: string): BudgetRecord {
  try {
    const record = storage.load(key) as { spent?: unknown; backoff?: { until?: unknown; strikes?: unknown } | null } | null;
    const spent = Array.isArray(record?.spent) ? (record.spent as unknown[]).filter((pair): pair is [number, number] => Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number") : [];
    const wait = record?.backoff;
    const backoff = typeof wait === "object" && wait !== null && typeof wait.until === "number" && typeof wait.strikes === "number" ? { until: wait.until, strikes: wait.strikes } : null;
    return { spent, backoff };
  } catch {
    return { spent: [], backoff: null };
  }
}

export const BURST_FILES = 20;
export const WRITES_PER_MINUTE = 100;
export const GITHUB_WRITES_PER_HOUR = 500;
export const PERSON_RESERVE = 100;
export const WRITES_PER_HOUR = GITHUB_WRITES_PER_HOUR - PERSON_RESERVE;
export const FIRST_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class WriteBudget {
  private blockedUntil: number;
  private strikes: number;
  private spent: Array<[at: number, cost: number]>;

  constructor(
    spent: Array<[at: number, cost: number]> = [],
    private readonly now: () => number = Date.now,
    backoff: { until: number; strikes: number } | null = null,
    private readonly serverTakes: () => number = () => 0,
    private readonly keep: (record: BudgetRecord) => void = () => undefined,
  ) {
    this.spent = spent;
    this.blockedUntil = backoff?.until ?? 0;
    this.strikes = backoff?.strikes ?? 0;
  }

  static open(storage: LocalState, login: string, now: () => number = Date.now, serverTakes: () => number = () => 0): WriteBudget {
    const key = `${BUDGET_KEY}-${hashText(login.toLowerCase())}`;
    const stored = readRecord(storage, key);
    return new WriteBudget(stored.spent, now, stored.backoff, serverTakes, (record) => {
      try {
        storage.save(key, record);
      } catch {
        void 0;
      }
    });
  }

  private persist(): void {
    this.keep({ spent: this.history(), backoff: this.backoff() });
  }

  backoff(): { until: number; strikes: number } {
    return { until: this.blockedUntil, strikes: this.strikes };
  }

  history(): Array<[number, number]> {
    this.forget();
    return this.spent.map(([at, cost]) => [at, cost]);
  }

  private forget(): void {
    const cutoff = this.now() - HOUR;
    this.spent = this.spent.filter(([at]) => at > cutoff);
  }

  hourCap(): number {
    return Math.max(0, WRITES_PER_HOUR - this.serverTakes());
  }

  waitFor(cost: number): number {
    this.forget();
    const now = this.now();
    let wait = Math.max(0, this.blockedUntil - now);
    for (const [span, cap] of [[MINUTE, WRITES_PER_MINUTE], [HOUR, this.hourCap()]] as const) {
      const need = Math.min(cost, cap);
      const inSpan = this.spent.filter(([at]) => at > now - span);
      let total = inSpan.reduce((sum, [, spentCost]) => sum + spentCost, 0);
      if (total + need <= cap) continue;
      for (const [at, spentCost] of inSpan) {
        total -= spentCost;
        if (total + need <= cap) {
          wait = Math.max(wait, at + span - now + 1);
          break;
        }
      }
    }
    return wait;
  }

  hourUse(): { used: number; cap: number } {
    this.forget();
    return { used: this.spent.reduce((sum, [, cost]) => sum + cost, 0), cap: this.hourCap() };
  }

  spend(cost: number): void {
    this.spent.push([this.now(), cost]);
    this.persist();
  }

  succeeded(): void {
    this.strikes = 0;
    if (this.blockedUntil <= this.now()) this.blockedUntil = 0;
    this.persist();
  }

  limited(retryAfterMs?: number): void {
    const now = this.now();
    if (this.strikes > 0 && this.blockedUntil > 0 && now >= this.blockedUntil + MAX_BACKOFF_MS) this.strikes = 0;
    const fallback = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** this.strikes);
    const wait =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(MAX_BACKOFF_MS, Math.max(MIN_RETRY_AFTER_MS, Math.ceil(retryAfterMs)))
        : fallback;
    this.blockedUntil = Math.max(this.blockedUntil, now + wait);
    this.strikes++;
    this.persist();
  }
}

export const EDIT_QUIET_MS = 5_000;
export const SAVE_GAP_MS = 15_000;
export const SAVE_GAP_HALF_MS = 60_000;
export const SAVE_GAP_MOST_MS = 5 * 60_000;

export class Pace {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly budget: WriteBudget,
    private readonly now: () => number = Date.now,
  ) {}

  gap(): number {
    const { used, cap } = this.budget.hourUse();
    if (cap <= 0 || used >= cap * 0.8) return SAVE_GAP_MOST_MS;
    return used > cap / 2 ? SAVE_GAP_HALF_MS : SAVE_GAP_MS;
  }

  saved(path: string): void {
    this.last.set(path, this.now());
  }

  waitFor(path: string, modifiedAt: number, agreedAt?: number): number {
    const now = this.now();
    const lastSave = Math.max(this.last.get(path) ?? Number.NEGATIVE_INFINITY, agreedAt ?? Number.NEGATIVE_INFINITY);
    return Math.max(0, modifiedAt + EDIT_QUIET_MS - now, lastSave + this.gap() - now);
  }
}
