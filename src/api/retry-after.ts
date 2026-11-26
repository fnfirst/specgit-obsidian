import { headerOf } from "../auth/transport";
import { GITHUB_FAST_FAIL_HEADER } from "../shared/review-flow";

export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 15 * 60_000;
export const FAST_FAIL_HEADER = GITHUB_FAST_FAIL_HEADER;

const EPOCH_SECONDS_FLOOR = 1_000_000_000;
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4}$/;

function clampMs(ms: number, maxMs: number, minMs: number = MIN_RETRY_AFTER_MS): number | undefined {
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  if (!Number.isFinite(ms)) return maxMs;
  return Math.min(Math.max(Math.ceil(ms), minMs), maxMs);
}

function parseHttpDate(trimmed: string): number {
  if (IMF_FIXDATE.test(trimmed) || RFC850_DATE.test(trimmed)) return Date.parse(trimmed);
  if (ASCTIME_DATE.test(trimmed)) return Date.parse(`${trimmed} GMT`);
  return Number.NaN;
}

function parseDeltaOrDate(raw: string, now: number, maxMs: number): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return clampMs(Number(trimmed) * 1000, maxMs);
  const at = parseHttpDate(trimmed);
  return Number.isFinite(at) ? clampMs(at - now, maxMs) : undefined;
}

function parseReset(raw: string, now: number, maxMs: number): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (Number.isNaN(value) || value <= 0) return undefined;
  if (!Number.isFinite(value)) return maxMs;
  return value >= EPOCH_SECONDS_FLOOR ? clampMs(value * 1000 - now, maxMs) : clampMs(value * 1000, maxMs);
}

function parseRateLimit(raw: string, maxMs: number): number | undefined {
  const match = /(?:^|[;,\s])(?:t|reset)=(\d+(?:\.\d+)?)(?:$|[;,\s])/i.exec(raw);
  if (!match) return undefined;
  return clampMs(Number(match[1]) * 1000, maxMs);
}

export function parseRetryAfterMs(headers: Record<string, string> | undefined, now: number = Date.now(), maxMs: number = MAX_RETRY_AFTER_MS): number | undefined {
  if (!headers) return undefined;
  const bag = { headers };
  const retryAfter = headerOf(bag, "retry-after");
  if (retryAfter !== undefined) {
    const ms = parseDeltaOrDate(retryAfter, now, maxMs);
    if (ms !== undefined) return ms;
  }
  const reset = headerOf(bag, "ratelimit-reset") ?? headerOf(bag, "x-ratelimit-reset");
  if (reset !== undefined) {
    const ms = parseReset(reset, now, maxMs);
    if (ms !== undefined) return ms;
  }
  const rateLimit = headerOf(bag, "ratelimit");
  if (rateLimit !== undefined) {
    const ms = parseRateLimit(rateLimit, maxMs);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

export function retryAfterFromResponse(
  headers: Record<string, string> | undefined,
  body: Record<string, unknown> | null,
  now: number = Date.now(),
  maxMs: number = MAX_RETRY_AFTER_MS,
): number | undefined {
  const fromHeader = parseRetryAfterMs(headers, now, maxMs);
  if (fromHeader !== undefined) return fromHeader;
  const sec = body?.retryAfterSec;
  if (typeof sec === "number") return clampMs(sec * 1000, maxMs);
  const ms = body?.retryAfterMs;
  if (typeof ms === "number") return clampMs(ms, maxMs);
  return undefined;
}

export function retryAfterFromError(error: unknown, maxMs: number = MAX_RETRY_AFTER_MS): number | undefined {
  const ms = typeof error === "object" && error !== null ? (error as { retryAfterMs?: unknown }).retryAfterMs : undefined;
  return typeof ms === "number" ? clampMs(ms, maxMs) : undefined;
}

export function isFastFailResponse(
  headers: Record<string, string> | undefined,
  body: Record<string, unknown> | null,
): boolean {
  if (headers && headerOf({ headers }, FAST_FAIL_HEADER)?.trim() === "1") return true;
  return body?.fastFail === true;
}
