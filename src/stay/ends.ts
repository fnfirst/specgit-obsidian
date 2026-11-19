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
