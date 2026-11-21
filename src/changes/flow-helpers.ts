import { noteName } from "../mapping";
import { isLostAnswerResult, type StepResult } from "../review/review-api";
import { isBurstUnavailable } from "../shared/review-flow";
import type { ChangeRow } from "./model";
import { gitBlobSha } from "./blob-sha";

export type AutoCommit = "committed" | "held" | "limited" | "retry" | "unsure" | "later" | "conflict" | "deleted";

export interface Carried {
  text: string;
  body: string;
  main: string;
  branch?: string;
}

export type Sent =
  | { ok: true; expectMain: string | null; inVault?: false; unchanged?: true; attachments?: string }
  | { ok: false; message: string; moved?: true; carried?: Carried; decide?: true; limited?: true; retryAfterMs?: number; unsure?: true; unreadable?: true; deleted?: number }
  | { ok: false; held: true };

export const MOVED_ATTEMPTS = 3;
export const MOVED_AGAIN = (name: string): string => `${name} kept changing on GitHub. Nothing was lost. Try again in a moment.`;
export const isLimited = (result: Extract<StepResult, { ok: false }>): boolean => result.status === 429 || result.code === "rate_limited";
export const isDenied = (result: Extract<StepResult, { ok: false }>): boolean => result.status === 401 || result.status === 403;

export function transientFailure(result: Extract<StepResult, { ok: false }>, fallback: string): Sent | null {
  if (isLostAnswerResult(result)) return { ok: false, unsure: true, message: failure(result, fallback) };
  if (isLimited(result)) return { ok: false, limited: true, message: failure(result, fallback), ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
  if (isBurstUnavailable(result)) return { ok: false, unreadable: true, message: failure(result, fallback) };
  return null;
}

export function autoOutcome(sent: Sent, options: { conflicted?: boolean; retryMoved?: boolean } = {}): { result: AutoCommit; retryAfterMs?: number } | null {
  if (sent.ok) return { result: "committed" };
  if ("held" in sent) return { result: options.conflicted ? "conflict" : "held" };
  if (sent.deleted !== undefined) return { result: "deleted" };
  if (sent.limited) return { result: "limited", ...(sent.retryAfterMs === undefined ? {} : { retryAfterMs: sent.retryAfterMs }) };
  if (sent.unsure) return { result: "unsure" };
  if (sent.unreadable) return { result: "later" };
  if (sent.decide) return { result: "held" };
  if (options.retryMoved && sent.moved) return null;
  return { result: "retry" };
}
export const BRANCH_MOVED_AGAIN = (name: string): string => `The review of ${name} kept changing on GitHub. Nothing was lost. Try again in a moment.`;
export const DELETED_ON_GITHUB = (name: string): string => `${name} was deleted on GitHub. Your copy is still in this vault.`;
export const REVIEW_UNCHECKED_TITLE = "Nothing was changed";
export const REVIEW_UNCHECKED = (names: readonly string[]): string => (names.length === 1 ? `Couldn't check the review of ${names[0]!} on GitHub. Try again in a moment.` : `Couldn't check ${names.length} reviews on GitHub. Try again in a moment.`);
export const UNREADABLE = (name: string): string => `specgit couldn't load ${name} from GitHub just now, so nothing was sent. Try again in a moment.`;

export const NO_CHANGE_TITLE = "Nothing to send";
export const NO_CHANGE_TO_SEND = "Nothing to send: this note differs from the version in GitHub only in line endings or spacing.";
export const noChangeWords = (names: readonly string[], all: boolean): string | null =>
  names.length === 0 ? null : all && names.length === 1 ? NO_CHANGE_TO_SEND : `Nothing to send for ${names.join(", ")}: ${names.length === 1 ? "it differs" : "they differ"} from the version in GitHub only in line endings or spacing.`;

export function headOf(body: Record<string, unknown> | null): { source: string; sha: string } | null {
  const head = body?.head as { source?: unknown; sha?: unknown } | undefined;
  return typeof head?.source === "string" && typeof head.sha === "string" ? { source: head.source, sha: head.sha } : null;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < items.length; at = next++) out[at] = await fn(items[at]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const names = (rows: readonly ChangeRow[]) => rows.map((row) => noteName(row.change.path)).join(", ");
export const failure = (result: Extract<StepResult, { ok: false }>, fallback: string): string => result.message || fallback;

export async function blobShasOf(texts: ReadonlyArray<readonly [string, string]>): Promise<Array<readonly [string, string]>> {
  const out: Array<readonly [string, string]> = [];
  const encoder = new TextEncoder();
  for (let at = 0; at < texts.length; at += 200) out.push(...(await Promise.all(texts.slice(at, at + 200).map(async ([path, text]) => [path, await gitBlobSha(encoder.encode(text))] as const))));
  return out;
}
