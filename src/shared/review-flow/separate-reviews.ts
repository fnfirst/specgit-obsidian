export const SEPARATE_ASK_FROM = 6;

export function newSeparateReviews(selected: readonly { hasReview: boolean }[]): number {
  return selected.filter((one) => !one.hasReview).length;
}

export const asksBeforeSeparate = (count: number): boolean => count >= SEPARATE_ASK_FROM;

export const SEPARATE_ASK = {
  title: (count: number, upTo = false): string => (upTo ? `Send up to ${count} separate reviews?` : `Send ${count} files as ${count} separate reviews?`),

  description: (canGroup: boolean, renamed = 0, groupable = 0, learned = false, mayRename = false): string => {

    if (learned) return SEPARATE_ASK.reason;

    if (mayRename && renamed > 0) {
      const own = `The ${renamed} renamed ${renamed === 1 ? "file may get its" : "files may each get their"} own review${groupable > 0 ? ", and every other file will" : ""}.`;
      return canGroup ? `${own} Grouping sends the other ${groupable} as one.` : own;
    }
    const first = "Each one gets its own review.";
    if (!canGroup) return first;
    if (renamed === 0) return `${first} Grouping them sends them as one.`;
    return `${first} Grouping sends the ${groupable} that can be grouped as one. The ${renamed} renamed ${renamed === 1 ? "file can't be grouped, so it still gets its" : "files can't be grouped, so they still get their"} own.`;
  },

  reason: "This repository needs a review before changes go in, so each renamed file needs its own review.",
  group: "Group them",
  separate: "Send separately",
} as const;
