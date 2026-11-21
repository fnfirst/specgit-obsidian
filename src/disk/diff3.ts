import { type Budget, diffTokens, type Hunk } from "./diff";

export type Chunk =
  | { kind: "merged"; tokens: string[] }
  | { kind: "conflict"; base: string[]; mine: string[]; theirs: string[] };

interface Change extends Hunk {
  side: "mine" | "theirs";
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((token, i) => token === b[i]);

export function diff3(base: readonly string[], mine: readonly string[], theirs: readonly string[], budget: Budget, gap = 0): Chunk[] {
  const changes: Change[] = [
    ...diffTokens(base, mine, budget, gap).map((hunk): Change => ({ ...hunk, side: "mine" })),
    ...diffTokens(base, theirs, budget, gap).map((hunk): Change => ({ ...hunk, side: "theirs" })),
  ];
  changes.sort((a, b) => a.aFrom - b.aFrom);
  const chunks: Chunk[] = [];
  let at = 0;
  for (let i = 0; i < changes.length; ) {
    const first = changes[i] as Change;
    let end = first.aTo;
    let next = i + 1;
    for (let other = changes[next]; other && other.aFrom <= end; other = changes[next]) {
      end = Math.max(end, other.aTo);
      next++;
    }
    if (first.aFrom > at) chunks.push({ kind: "merged", tokens: base.slice(at, first.aFrom) });
    const stretch = changes.slice(i, next);
    const [ours, theirsHere] = [sideOf(stretch, "mine", mine, base, first.aFrom, end), sideOf(stretch, "theirs", theirs, base, first.aFrom, end)];
    const original = base.slice(first.aFrom, end);
    chunks.push(...settle(original, ours, theirsHere, budget, gap));
    at = end;
    i = next;
  }
  if (at < base.length) chunks.push({ kind: "merged", tokens: base.slice(at) });
  return chunks;
}

function settle(base: readonly string[], mine: readonly string[], theirs: readonly string[], budget: Budget, gap: number): Chunk[] {
  if (same(mine, theirs) || same(theirs, base)) return [{ kind: "merged", tokens: [...mine] }];
  if (same(mine, base)) return [{ kind: "merged", tokens: [...theirs] }];
  let head = 0;
  while (head < mine.length && head < theirs.length && mine[head] === theirs[head]) head++;
  let tail = 0;
  while (tail < mine.length - head && tail < theirs.length - head && mine[mine.length - 1 - tail] === theirs[theirs.length - 1 - tail]) tail++;
  const [ours, there] = [mine.slice(head, mine.length - tail), theirs.slice(head, theirs.length - tail)];
  const [inMine, inTheirs] = [baseAt(diffTokens(base, mine, budget, gap), head, mine.length - tail), baseAt(diffTokens(base, theirs, budget, gap), head, theirs.length - tail)];
  const middle: Chunk = same(ours, base.slice(...inMine))
    ? { kind: "merged", tokens: there }
    : same(there, base.slice(...inTheirs))
      ? { kind: "merged", tokens: ours }
      : { kind: "conflict", base: base.slice(Math.min(inMine[0], inTheirs[0]), Math.max(inMine[1], inTheirs[1])), mine: ours, theirs: there };
  return [
    ...(head > 0 ? [{ kind: "merged" as const, tokens: mine.slice(0, head) }] : []),
    middle,
    ...(tail > 0 ? [{ kind: "merged" as const, tokens: mine.slice(mine.length - tail) }] : []),
  ];
}

function baseAt(changes: readonly Hunk[], from: number, to: number): [number, number] {
  let delta = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const change of changes) {
    const deletion = change.bFrom === change.bTo;
    if (start === undefined) {
      if (from < change.bFrom) start = from - delta;
      else if (from < change.bTo || (deletion && from === change.bFrom)) start = change.aFrom;
    }
    if (end === undefined) {
      if (to < change.bFrom || (to === change.bFrom && !deletion)) end = to - delta;
      else if (to <= change.bTo) end = change.aTo;
    }
    if (start !== undefined && end !== undefined) break;
    delta = change.bTo - change.aTo;
  }
  return [start ?? from - delta, end ?? to - delta];
}

function sideOf(stretch: readonly Change[], side: Change["side"], text: readonly string[], base: readonly string[], from: number, to: number): string[] {
  const own = stretch.filter((change) => change.side === side);
  const [firstOwn, lastOwn] = [own[0], own.at(-1)];
  if (!firstOwn || !lastOwn) return base.slice(from, to);
  return text.slice(firstOwn.bFrom - (firstOwn.aFrom - from), lastOwn.bTo + (to - lastOwn.aTo));
}
