export interface Same {
  kind: "same";
  text: string;
}

export interface Conflict {
  kind: "conflict";
  mine: string;
  theirs: string;
}

export type Region = Same | Conflict;

export type Choice = "mine" | "theirs" | "both" | { edited: string };

export const isConflict = (region: Region): region is Conflict => region.kind === "conflict";

export const conflictsIn = (regions: readonly Region[]): number => regions.filter(isConflict).length;

export function both({ mine, theirs }: Conflict): string {
  return mine !== "" && theirs !== "" && !mine.endsWith("\n") ? `${mine}\n${theirs}` : mine + theirs;
}

export function chosen(conflict: Conflict, choice: Choice): string {
  if (choice === "mine") return conflict.mine;
  if (choice === "theirs") return conflict.theirs;
  return choice === "both" ? both(conflict) : choice.edited;
}

export function theirsStanding(regions: readonly Region[]): string {
  return regions.map((region) => (isConflict(region) ? region.theirs : region.text)).join("");
}

export function resolved(regions: readonly Region[], choices: ReadonlyArray<Choice | undefined>): string | null {
  let at = 0;
  let text = "";
  for (const region of regions) {
    if (!isConflict(region)) {
      text += region.text;
      continue;
    }
    const choice = choices[at++];
    if (choice === undefined) return null;
    text += chosen(region, choice);
  }
  return text;
}

export interface Change {
  kind: "change";
  before: string;
  after: string;
}

export interface Heading {
  kind: "heading";
  text: string;
}

export type Shown = Same | Change | Heading;

export const changesIn = (shown: readonly Shown[]): number => shown.filter((part) => part.kind === "change").length;

export const cameInWords = (count: number): string => `${count} ${count === 1 ? "change" : "changes"} came in`;

const places = (count: number): string => `${count} ${count === 1 ? "place" : "places"}`;

export const cameInNow = (count: number, kept: boolean): string => `${cameInWords(count)}${kept ? ". Your own edits were kept." : ""}`;

export function joinedWords(split: { unpublished: number | null; published: number }, by: string | null, kept: boolean): string {
  const { unpublished, published } = split;
  const own = kept ? " Your own edits were kept." : "";
  if (unpublished === 0) return cameInNow(published, kept);
  const head = by === null ? "Unpublished changes" : `Unpublished changes from ${by}'s draft`;

  if (unpublished === null) return `${head} came in.${own}`;
  const also = published > 0 ? ` ${published} published ${published === 1 ? "change" : "changes"} came in too.` : "";
  return `${head} came in (${places(unpublished)}).${also}${own}`;
}
