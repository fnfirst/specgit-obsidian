import { CHANGE_GRACE_MS } from "../shared/review-flow";
import type { ReviewFacts } from "../shared/status-panel";

export const HELD_RECHECK_MS = [2_500, 6_000] as const;

interface HeldMove {
  isDraft: boolean;
  at: number;
  seq: number;
  requestedReviewers?: readonly string[];
}

export interface DraftHoldHost {
  now: () => number;
  repo: () => string;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  recheck: (numbers: readonly number[]) => void;
  onChanged: () => void;
}

function uniqueLogins(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const login of logins) {
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

function moveAgrees(known: ReviewFacts, move: HeldMove): boolean {
  if (known.isDraft !== move.isDraft) return false;
  if (move.isDraft || !move.requestedReviewers || move.requestedReviewers.length === 0) return true;
  const seen = new Set([
    ...known.requestedReviewers.map((login) => login.toLowerCase()),
    ...known.reviewers.map((one) => one.login.toLowerCase()),
  ]);
  return move.requestedReviewers.every((login) => seen.has(login.toLowerCase()));
}

function sameReviewers(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  if (!a || !b) return true;
  return a.every((one, at) => one.toLowerCase() === b[at]!.toLowerCase());
}

export class DraftHold {
  private readonly moves = new Map<number, HeldMove>();
  private forRepo = "";
  private recheckTimers: unknown[] = [];
  private expiryTimer: unknown = null;
  private lastFacts: ReadonlyMap<number, ReviewFacts> = new Map();

  constructor(private readonly host: DraftHoldHost) {}

  clear(): void {
    this.cancelTimers();
    this.moves.clear();
  }

  private cancelRechecks(): void {
    for (const handle of this.recheckTimers) this.host.clearTimer(handle);
    this.recheckTimers = [];
  }

  private cancelExpiry(): void {
    if (this.expiryTimer === null) return;
    this.host.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
  }

  private cancelTimers(): void {
    this.cancelRechecks();
    this.cancelExpiry();
  }

  private scheduleRechecks(): void {
    this.cancelRechecks();
    if (this.moves.size === 0) return;
    const run = (): void => {
      if (this.reconcile(this.lastFacts)) this.host.onChanged();
      if (this.moves.size === 0) return;
      this.host.recheck([...this.moves.keys()]);
    };
    for (const ms of HELD_RECHECK_MS) this.recheckTimers.push(this.host.setTimer(run, ms));
  }

  private scheduleExpiry(): void {
    this.cancelExpiry();
    if (this.moves.size === 0) return;
    const now = this.host.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const move of this.moves.values()) earliest = Math.min(earliest, move.at + CHANGE_GRACE_MS);
    const wait = Math.max(0, earliest - now) + 50;
    this.expiryTimer = this.host.setTimer(() => {
      this.expiryTimer = null;
      if (this.reconcile(this.lastFacts)) this.host.onChanged();
      if (this.expiryTimer === null) this.scheduleExpiry();
    }, wait);
  }

  record(
    prNumber: number,
    isDraft: boolean,
    seq: number,
    facts: ReadonlyMap<number, ReviewFacts>,
    inFlightRead: boolean,
    requestedReviewers?: readonly string[],
  ): boolean {
    if (prNumber <= 0) return false;
    this.lastFacts = facts;
    const repo = this.host.repo();
    if (this.forRepo !== repo) {
      this.clear();
      this.forRepo = repo;
    }
    const now = this.host.now();
    const rawWas = this.moves.get(prNumber);
    const was = rawWas && now - rawWas.at < CHANGE_GRACE_MS ? rawWas : undefined;
    const sameSide = was !== undefined && was.isDraft === isDraft;
    const incoming = !isDraft && requestedReviewers && requestedReviewers.length > 0 ? uniqueLogins(requestedReviewers) : undefined;
    const asked = isDraft
      ? undefined
      : incoming
        ? uniqueLogins([...(sameSide ? (was.requestedReviewers ?? []) : []), ...incoming])
        : sameSide
          ? was.requestedReviewers
          : undefined;
    const candidate: HeldMove = { isDraft, at: now, seq, ...(asked && asked.length > 0 ? { requestedReviewers: asked } : {}) };
    const existing = facts.get(prNumber);
    if (!was && !inFlightRead && existing && moveAgrees(existing, candidate)) return false;
    if (sameSide && sameReviewers(was.requestedReviewers, candidate.requestedReviewers)) return false;
    this.moves.set(prNumber, candidate);
    this.scheduleRechecks();
    this.scheduleExpiry();
    return true;
  }

  reconcile(facts: ReadonlyMap<number, ReviewFacts>, settled?: ReadonlyMap<number, ReviewFacts>, settledSeq?: number): boolean {
    this.lastFacts = facts;
    const repo = this.host.repo();
    if (this.forRepo !== repo) {
      const had = this.moves.size > 0;
      this.clear();
      this.forRepo = repo;
      return had;
    }
    if (this.moves.size === 0) return false;
    const now = this.host.now();
    let dropped = false;
    for (const [number, move] of [...this.moves]) {
      const expired = now - move.at >= CHANGE_GRACE_MS;
      const known = settled?.get(number);
      const agreed = settledSeq !== undefined && settledSeq > move.seq && known !== undefined && moveAgrees(known, move);
      if (expired || agreed) {
        this.moves.delete(number);
        dropped = true;
      }
    }
    if (dropped) {
      if (this.moves.size === 0) this.cancelTimers();
      else this.scheduleExpiry();
    }
    return dropped;
  }

  apply(facts: ReadonlyMap<number, ReviewFacts>): ReadonlyMap<number, ReviewFacts> {
    if (this.moves.size === 0) return facts;
    const shown = new Map(facts);
    for (const [number, move] of this.moves) {
      const known = shown.get(number);
      if (!known) continue;
      const asked = !move.isDraft && move.requestedReviewers && move.requestedReviewers.length > 0 ? move.requestedReviewers : undefined;
      const seen = asked
        ? new Set([
            ...known.requestedReviewers.map((login) => login.toLowerCase()),
            ...known.reviewers.map((one) => one.login.toLowerCase()),
          ])
        : null;
      const missing = asked && seen ? asked.filter((login) => !seen.has(login.toLowerCase())) : [];
      shown.set(number, {
        ...known,
        isDraft: move.isDraft,
        ...(missing.length > 0
          ? {
              requestedReviewers: [...known.requestedReviewers, ...missing],
              reviewers: [...known.reviewers, ...missing.map((login) => ({ login, state: "requested" as const }))],
            }
          : {}),
      });
    }
    return shown;
  }
}
