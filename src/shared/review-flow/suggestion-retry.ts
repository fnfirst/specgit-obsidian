export interface SuggestionSnapshot {
  replaceNeedle: string;
  beforeReplaceCount: number;
  afterReplaceCount: number;
  findNeedle: string;
  beforeFindCount: number;
  afterFindCount: number;
  sourceReplace: string;
  beforeSourceCount: number;
  afterSourceCount: number;
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function countOccurrences(haystack: string, needle: string): number {
  const normalizedNeedle = normalizeLineEndings(needle);
  if (!normalizedNeedle) return 0;
  const normalizedHaystack = normalizeLineEndings(haystack);
  let count = 0;
  let idx = 0;
  while ((idx = normalizedHaystack.indexOf(normalizedNeedle, idx)) >= 0) {
    count += 1;
    idx += normalizedNeedle.length;
  }
  return count;
}

export function isSuggestionStillApplied(
  snapshot: SuggestionSnapshot,
  counts: {
    replaceCount(needle: string): number;
    findCount(needle: string): number;
    sourceCount(needle: string): number;
  },
): boolean {
  if (snapshot.replaceNeedle !== "" && snapshot.afterReplaceCount > snapshot.beforeReplaceCount) {
    return counts.replaceCount(snapshot.replaceNeedle) >= snapshot.afterReplaceCount;
  }
  if (snapshot.sourceReplace !== "" && snapshot.afterSourceCount > snapshot.beforeSourceCount) {
    return counts.sourceCount(snapshot.sourceReplace) >= snapshot.afterSourceCount;
  }
  if (snapshot.findNeedle !== "" && snapshot.afterFindCount < snapshot.beforeFindCount) {
    return counts.findCount(snapshot.findNeedle) <= snapshot.afterFindCount;
  }
  return false;
}
