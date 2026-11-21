import type { DialogWords, Point } from "./flow-deps";
import type { ChangesPhase } from "./model";

export const DISCARD = {
  menu: "Discard my changes…",
  command: "Discard all local changes…",
  confirm: "Discard changes",
  busy: "Discarding…",
  footer: (files: number): string => `Discard changes to ${files} ${files === 1 ? "file" : "files"}…`,
} as const;

export function nothingToDiscard(phase: ChangesPhase): { title: string; description: string } {
  switch (phase) {
    case "ready":
      return { title: "Nothing to discard", description: "Your notes already match the versions in GitHub." };
    case "loading":
      return { title: "Still checking", description: "specgit is still comparing your notes with GitHub. Try again in a moment." };
    case "signed-out":
      return { title: "Sign in first", description: "Sign in to specgit so it can compare your notes with GitHub." };
    case "offline":
      return { title: "Can't check right now", description: "specgit can't reach GitHub, so it can't tell what you've changed. Try again when you're back online." };
    case "not-installed":
    case "unmapped":
      return { title: "Nothing to compare yet", description: "Choose a repository for this vault first, and give specgit access to it." };
  }
}

export interface DiscardCounts {
  edited: number;
  renamed: number;
  added: number;
  deleted: number;
  reviews: number;
  grouped: number;
  roomed: number;
  others: number;
  roomedNew: number;
}

export interface LeftAlone {
  name: string;
  why: SkipReason;
}

export interface DiscardWorld {
  deletesForGood: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const listed = (parts: readonly string[]): string => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`);

const ICON = { back: "undo-2", trash: "trash-2", people: "users", review: "git-pull-request-closed", group: "ungroup", left: "circle-slash" } as const;

export const CANT_UNDO = "This operation cannot be undone.";

export function discardTitle(files: number, name: string): string {
  return files === 1 ? `Discard your changes to ${name}?` : `Discard changes to ${files} notes?`;
}

export function discardAsk(counts: DiscardCounts, world: DiscardWorld, left: readonly LeftAlone[] = []): DialogWords {
  const one = counts.edited + counts.renamed + counts.added + counts.deleted === 1;
  const points: Point[] = one ? [] : restOfMany(counts, world);
  if (counts.roomed > 0) points.push({ icon: ICON.people, text: peopleLine(counts, one) });
  const closing = counts.reviews - counts.grouped;
  if (closing > 0) points.push({ icon: ICON.review, text: one ? "Its review on GitHub will be closed" : `${plural(closing, "review", "reviews")} on GitHub will be closed` });
  if (counts.grouped > 0) points.push({ icon: ICON.group, text: one ? "It will be removed from its group" : `${plural(counts.grouped, "note", "notes")} will be removed from ${counts.grouped === 1 ? "its group" : "their groups"}` });
  for (const { name, why } of left) points.push({ icon: ICON.left, text: `${name} won't be changed: ${SKIPPED[why].why}` });
  const lost = counts.edited + counts.renamed > 0 || (counts.added > 0 && world.deletesForGood);
  return { description: one ? oneNote(counts, world) : manyNotes(counts), points, ...(lost ? { note: CANT_UNDO } : {}) };
}

function oneNote(counts: DiscardCounts, world: DiscardWorld): string {
  if (counts.added > 0) return `This note isn't in GitHub yet, so it will be ${world.deletesForGood ? "permanently deleted" : "moved to the trash"}.`;
  if (counts.deleted > 0) return "This note will be restored from the version in GitHub.";
  if (counts.renamed > 0) return "This note will be moved back to its old name, and your local version will be replaced with the version in GitHub.";
  return "Your local version will be discarded and replaced with the version in GitHub.";
}

function manyNotes(counts: DiscardCounts): string | undefined {
  const back = counts.edited + counts.renamed;
  if (back === 0) return undefined;
  return back === 1 ? "Your local version of 1 note will be discarded and replaced with the version in GitHub." : `Your local versions of ${back} notes will be discarded and replaced with the versions in GitHub.`;
}

function restOfMany(counts: DiscardCounts, world: DiscardWorld): Point[] {
  const points: Point[] = [];
  if (counts.added > 0) points.push({ icon: ICON.trash, text: `${plural(counts.added, "new note", "new notes")} will be ${world.deletesForGood ? "permanently deleted" : "moved to the trash"}` });
  if (counts.deleted > 0) points.push({ icon: ICON.back, text: `${plural(counts.deleted, "deleted note", "deleted notes")} will be restored` });
  return points;
}

function peopleLine(counts: DiscardCounts, one: boolean): string {
  const what = one ? "this note" : counts.roomed === 1 ? "1 of these notes" : `${counts.roomed} of these notes`;
  if (counts.roomedNew === counts.roomed) {
    const lose = counts.roomed === 1 ? "it" : "them";
    if (counts.others > 0) return `${plural(counts.others, "other person is", "other people are")} editing ${what} right now, and will lose ${lose} too`;
    return `Anyone editing ${what} with you will lose ${lose} too`;
  }
  if (counts.others > 0) return `${plural(counts.others, "other person is", "other people are")} editing ${what} right now, and will get the GitHub version too`;
  return `Anyone editing ${what} with you will get the GitHub version too`;
}

export const SKIPPED: Record<SkipReason, { why: string; next?: string }> = {
  changed: { why: "it was edited after you were asked", next: "Discard again if you still want to." },
  held: { why: "Obsidian hasn't saved the latest typing in it yet", next: "Try again in a moment." },
  connecting: { why: "it is still connecting", next: "Try again in a moment." },
  stuck: { why: "live editing is paused for it", next: "Click Disconnect, then try again." },
  unreachable: { why: "specgit can't be reached right now", next: "Try again when you're back online." },
  theirs: { why: "it is in a review that someone else started" },
  failed: { why: "Obsidian couldn't change the file", next: "Try again." },
  unchecked: { why: "specgit couldn't check whether it is in a review", next: "Try again in a moment." },
  unsure: { why: "a review of it has just started, and specgit doesn't know yet whose it is", next: "Try again in a moment." },
  unreadable: { why: "the version in GitHub couldn't be loaded", next: "Try again in a moment." },
  absent: { why: "it is no longer in GitHub" },
  exists: { why: "another note already has that name" },
  review: { why: "its review on GitHub couldn't be closed", next: "Open the note and choose Stop the review in the Status tab." },
  reviewUnsure: { why: "specgit didn't answer, so its review on GitHub may still be open", next: "If it is, open the note and choose Stop the review in the Status tab." },
  reviewChanged: { why: "its review changed on GitHub just then, so specgit left it as it is" },
  keptTyping: { why: "it was replaced with the version in GitHub", next: "What you typed in the last moments was kept." },
  notReset: { why: "specgit couldn't reach the people editing it with you", next: "Try again in a moment." },
  place: { why: "this vault now uses a different repository" },
  gone: { why: "it is no longer in this vault" },
  unmapped: { why: "it isn't part of the repository" },
};
export type SkipReason = "changed" | "held" | "connecting" | "stuck" | "unreachable" | "theirs" | "failed" | "unchecked" | "unsure" | "unreadable" | "absent" | "exists" | "review" | "reviewChanged" | "reviewUnsure" | "keptTyping" | "notReset" | "place" | "gone" | "unmapped";

export interface Skipped {
  name: string;
  why: SkipReason;
  pr?: number;
  elsewhere?: boolean;
  grouped?: boolean;
}

export interface DiscardResult {
  restored: number;
  trashed: number;
  broughtBack: number;
  reviewsClosed: number;
  skipped: Skipped[];
}

export function discardedWords(result: DiscardResult, world: DiscardWorld): { title: string; description: string; points: Point[] } {
  const done: string[] = [];
  if (result.restored > 0) done.push(`${plural(result.restored, "note was", "notes were")} replaced with the version in GitHub`);
  if (result.trashed > 0) done.push(`${plural(result.trashed, "new note was", "new notes were")} ${world.deletesForGood ? "permanently deleted" : "moved to the trash"}`);
  if (result.broughtBack > 0) done.push(`${plural(result.broughtBack, "deleted note was", "deleted notes were")} restored`);
  if (result.reviewsClosed > 0) done.push(`${plural(result.reviewsClosed, "review was", "reviews were")} closed`);
  const description = done.length ? `${listed(done)}.` : "";
  const did = result.restored + result.trashed + result.broughtBack > 0;
  const unchanged = result.skipped.some((one) => !replaced(one.why));
  const title = !unchanged ? "Discarded your changes" : did ? "Discarded some of your changes" : "Nothing was discarded";
  return { title, description, points: result.skipped.map((one) => ({ icon: replaced(one.why) ? ICON.review : ICON.left, text: sentence(one) })) };
}

const stillGrouped = (elsewhere: boolean): string =>
  `In the Status tab, open its group and choose Take out of this group from the note's ⋯ menu. That gives it a review of its own, which you can ${elsewhere ? "close on GitHub" : "stop from its ⋯ menu"}.`;
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

const replaced = (why: SkipReason): boolean => why === "review" || why === "reviewChanged" || why === "reviewUnsure" || why === "keptTyping";

function sentence(one: Skipped): string {
  const { why, next } = SKIPPED[one.why];
  if (one.why === "reviewChanged") return `${one.name}: ${why}.`;
  if (one.why === "keptTyping") return `${one.name} was replaced with the version in GitHub. ${next}`;
  if (replaced(one.why) && one.grouped) {
    const step = stillGrouped(one.elsewhere === true);
    return `${one.name}: ${one.why === "review" ? `it couldn't be taken out of its group. ${step}` : `specgit didn't answer, so it may still be in its group. If it is, ${lowerFirst(step)}`}`;
  }
  if (replaced(one.why) && one.elsewhere && one.pr !== undefined) return `${one.name}: ${why}. ${one.why === "review" ? "You can close it" : "If it is, you can close it"} on GitHub, where it is pull request #${one.pr}.`;
  if (replaced(one.why)) return `${one.name}: ${why}. ${next}`;
  return `${one.name} wasn't changed: ${why}.${next ? ` ${next}` : ""}`;
}
