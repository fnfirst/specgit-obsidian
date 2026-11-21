import type { DocumentRef } from "../mapping";
import { type DetailsResult, reviewIsOpen } from "../review/review-api";
import type { PrInfo } from "../shared/review-flow";

export type End = "open" | "published" | "discarded" | "closed" | "closedUnnamed" | "none";

const same = (a: string | null | undefined, b: string): boolean => typeof a === "string" && b !== "" && a.toLowerCase() === b.toLowerCase();

export const closedByMe = (pr: Pick<PrInfo, "closedBy">, login: string): boolean => same(pr.closedBy, login);

export function endOf(pr: Pick<PrInfo, "state" | "closedBy" | "viewerWrote"> | null | undefined, login: string, group = false): End {
  if (pr?.state === "merged") return "published";
  if (pr?.state !== "closed") return "none";
  if (closedByMe(pr, login)) return "discarded";
  if (!group && pr.viewerWrote === false) return "discarded";
  return typeof pr.closedBy === "string" ? "closed" : "closedUnnamed";
}

export type ReviewEndsResult =
  | { kind: "unsupported" }
  | { kind: "answered"; ends: Map<number, End | "unknown">; retryAfterMs?: number };

export async function readReviewEnds(
  files: ReadonlyArray<{ doc: DocumentRef; number: number; group?: boolean }>,
  details: ((repo: string, numbers: readonly number[]) => Promise<DetailsResult>) | undefined,
  login: () => string,
  batchSize: number,
): Promise<ReviewEndsResult> {
  if (files.length === 0) return { kind: "answered", ends: new Map() };
  if (!details) return { kind: "unsupported" };
  const ends = new Map<number, End | "unknown">();
  let retryAfterMs: number | undefined;
  const byRepo = new Map<string, number[]>();
  const groups = new Set(files.filter((one) => one.group === true).map((one) => one.number));
  for (const { doc, number } of files) byRepo.set(doc.repo, [...(byRepo.get(doc.repo) ?? []), number]);
  outer: for (const [repo, numbers] of byRepo) {
    for (let at = 0; at < numbers.length; at += batchSize) {
      let read: DetailsResult;
      try {
        read = await details(repo, numbers.slice(at, at + batchSize));
      } catch {
        break outer;
      }
      if (read === null) return { kind: "unsupported" };
      if (!(read instanceof Map)) {
        if (typeof read === "object" && read.retryAfterMs !== undefined) retryAfterMs = read.retryAfterMs;
        break outer;
      }
      for (const [number, pr] of read) ends.set(number, reviewIsOpen({ reviewBranch: null, pr }) ? "open" : endOf(pr, login(), groups.has(pr.number)));
    }
  }
  return { kind: "answered", ends, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}
