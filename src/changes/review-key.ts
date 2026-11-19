export type ReviewKey = `pr:${number}` | `group:${number}`;

export function reviewKey(pr: { number?: unknown; group?: unknown } | null | undefined): ReviewKey | null {
  if (typeof pr?.number !== "number") return null;
  return pr.group ? `group:${pr.number}` : `pr:${pr.number}`;
}

export function sentToThis(sentTo: ReviewKey | null, now: ReviewKey | null): boolean {
  if (now === null) return false;
  if (now.startsWith("group:") || sentTo?.startsWith("group:")) return true;
  return sentTo === now;
}
