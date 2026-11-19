import type { CacheEntry } from "./cache";

export function unchangedHere(entry: Pick<CacheEntry, "sha" | "base" | "same" | "sameBy">): boolean {
  return entry.base !== null && (entry.sha === entry.base || (entry.same === entry.base && entry.sameBy !== "server"));
}
