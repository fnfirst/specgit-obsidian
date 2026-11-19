import { Budget, codePoints, diffTokens, splitLines, withoutFinalBreaks, WORD_GAP } from "./diff";
import { diff3 } from "./diff3";
import type { Change, Conflict, Region, Same, Shown } from "./regions";

const CHARACTER_MERGE_LIMIT = 20_000;

type Place = Conflict | Change;

function append(parts: Array<Place | Same>, text: string): void {
  if (text === "") return;
  const last = parts.at(-1);
  if (last?.kind === "same") last.text += text;
  else parts.push({ kind: "same", text });
}

export function mergeRegions(base: string, mine: string, theirs: string, budget: Budget): Region[] {
  const regions: Region[] = [];
  if (mine === theirs || base === theirs) append(regions, mine);
  else if (base === mine) append(regions, theirs);
  else {
    for (const chunk of diff3(splitLines(base), splitLines(mine), splitLines(theirs), budget)) {
      if (chunk.kind === "merged") {
        append(regions, chunk.tokens.join(""));
        continue;
      }
      const conflict: Conflict = { kind: "conflict", mine: chunk.mine.join(""), theirs: chunk.theirs.join("") };
      const merged = mergeCharacters(chunk.base.join(""), conflict.mine, conflict.theirs, budget);
      if (merged === null) regions.push(conflict);
      else append(regions, merged);
    }
  }
  return regions;
}

function mergeCharacters(base: string, mine: string, theirs: string, budget: Budget): string | null {
  if (base.length + mine.length + theirs.length > CHARACTER_MERGE_LIMIT || budget.over) return null;
  const chunks = diff3(codePoints(base), codePoints(mine), codePoints(theirs), budget, WORD_GAP);
  let text = "";
  for (const chunk of chunks) {
    if (chunk.kind === "conflict") return null;
    text += chunk.tokens.join("");
  }
  return text;
}

function layoutLines<Part extends Place>(a: string, b: string, budget: Budget, differ: (a: string, b: string) => Part): Array<Part | Same> {
  const [aLines, bLines] = [splitLines(a), splitLines(b)];
  const parts: Array<Part | Same> = [];
  let at = 0;
  for (const hunk of diffTokens(aLines, bLines, budget)) {
    append(parts, aLines.slice(at, hunk.aFrom).join(""));
    parts.push(differ(aLines.slice(hunk.aFrom, hunk.aTo).join(""), bLines.slice(hunk.bFrom, hunk.bTo).join("")));
    at = hunk.aTo;
  }
  append(parts, aLines.slice(at).join(""));
  return parts;
}

export function twoWayRegions(mine: string, theirs: string, budget: Budget): Region[] {
  return layoutLines(mine, theirs, budget, (own, live): Conflict => ({ kind: "conflict", mine: own, theirs: live }));
}

const CAME_IN_MS = 400;

export function changesBetween(before: string, after: string, budget = new Budget(CAME_IN_MS)): Shown[] | null {
  if (withoutFinalBreaks(before) === withoutFinalBreaks(after)) return null;
  return layoutLines(before, after, budget, (was, now): Change => ({ kind: "change", before: was, after: now }));
}

export function unpublishedPlaces(came: readonly Shown[], git: string | null, room: string): { unpublished: number | null; published: number } | null {
  if (git === null) return null;
  const roomPlaces = (changesBetween(git, room) ?? []).flatMap((part) => (part.kind === "change" ? [part.after] : []));
  const changes = came.filter((part): part is Change => part.kind === "change");
  const matched = new Set<number>();
  let published = 0;
  for (const part of changes) {
    const hits = part.after === "" ? [] : roomPlaces.flatMap((place, at) => (place !== "" && (place.includes(part.after) || part.after.includes(place)) ? [at] : []));
    if (hits.length > 1 || (part.after === "" && roomPlaces.some((place) => place === ""))) return { unpublished: null, published: 0 };
    if (hits.length === 1) matched.add(hits[0]!);
    else published += 1;
  }
  return { unpublished: matched.size, published };
}
