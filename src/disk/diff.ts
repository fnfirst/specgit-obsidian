import { diff as trimEnds, type Splice } from "../editor/splice";

export class Budget {
  private readonly deadline: number;

  constructor(
    ms: number,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.deadline = clock() + ms;
  }

  get over(): boolean {
    return this.clock() >= this.deadline;
  }
}

export interface Hunk {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

const MAX_EDITS = 1500;

export const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export const withoutFinalBreaks = (text: string): string => text.replace(/\n+$/, "");

export const codePoints = (text: string): string[] => Array.from(text);

function offsetsOf(tokens: readonly string[]): number[] {
  const offsets = [0];
  for (const token of tokens) offsets.push((offsets.at(-1) ?? 0) + token.length);
  return offsets;
}

export function diffTokens(a: readonly string[], b: readonly string[], budget: Budget, gap = 0): Hunk[] {
  let start = 0;
  const shortest = Math.min(a.length, b.length);
  while (start < shortest && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const whole: Hunk = { aFrom: start, aTo: endA, bFrom: start, bTo: endB };
  if (start === endA || start === endB) return [whole];
  const ids = new Map<string, number>();
  const idOf = (token: string): number => {
    const known = ids.get(token);
    if (known !== undefined) return known;
    ids.set(token, ids.size);
    return ids.size - 1;
  };
  const inner = myers(a.slice(start, endA).map(idOf), b.slice(start, endB).map(idOf), budget);
  if (!inner) return [whole];
  const hunks: Hunk[] = [];
  for (const found of inner) {
    const hunk = { aFrom: found.aFrom + start, aTo: found.aTo + start, bFrom: found.bFrom + start, bTo: found.bTo + start };
    const previous = hunks.at(-1);
    if (previous && hunk.aFrom - previous.aTo <= gap) {
      previous.aTo = hunk.aTo;
      previous.bTo = hunk.bTo;
    } else hunks.push(hunk);
  }
  return hunks;
}

export const WORD_GAP = 3;

function myers(a: number[], b: number[], budget: Budget): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const reach = new Int32Array(2 * limit + 3);
  const rounds: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    if (budget.over) return null;
    rounds.push(reach.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (reach[offset + k - 1] ?? 0) < (reach[offset + k + 1] ?? 0));
      let x = down ? (reach[offset + k + 1] ?? 0) : (reach[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      reach[offset + k] = x;
      if (x >= n && y >= m) return walkBack(rounds, d, n, m);
    }
  }
  return null;
}

function walkBack(rounds: Int32Array[], last: number, n: number, m: number): Hunk[] {
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = last; d > 0; d--) {
    const before = rounds[d] ?? new Int32Array(0);
    const reached = (k: number): number => before[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && reached(k - 1) < reached(k + 1));
    const fromX = reached(down ? k + 1 : k - 1);
    const fromY = fromX - (down ? k + 1 : k - 1);
    const middleX = down ? fromX : fromX + 1;
    const middleY = down ? fromY + 1 : fromY;
    const next = hunks[0];
    if (next && middleX === x && middleY === y) {
      next.aFrom = fromX;
      next.bFrom = fromY;
    } else hunks.unshift({ aFrom: fromX, aTo: middleX, bFrom: fromY, bTo: middleY });
    x = fromX;
    y = fromY;
  }
  return hunks;
}

const SMALL_CHANGE = 200;

const CHARACTER_SEARCH_LIMIT = 20_000;

export function splices(before: string, after: string, budget: Budget): Splice[] {
  const around = trimEnds(before, after);
  if (!around) return [];
  const old = before.slice(around.from, around.to);
  if (old.length + around.insert.length <= SMALL_CHANGE) return [around];
  const [oldLines, newLines] = [splitLines(old), splitLines(around.insert)];
  const [oldStarts, newStarts] = [offsetsOf(oldLines), offsetsOf(newLines)];
  return diffTokens(oldLines, newLines, budget).flatMap((hunk) =>
    withinLines(around.from + (oldStarts[hunk.aFrom] ?? 0), old.slice(oldStarts[hunk.aFrom], oldStarts[hunk.aTo]), around.insert.slice(newStarts[hunk.bFrom], newStarts[hunk.bTo]), budget),
  );
}

function withinLines(from: number, old: string, now: string, budget: Budget): Splice[] {
  const narrow = trimEnds(old, now);
  if (!narrow) return [];
  const start = from + narrow.from;
  const oldPart = old.slice(narrow.from, narrow.to);
  const size = oldPart.length + narrow.insert.length;
  if (size <= SMALL_CHANGE || size > CHARACTER_SEARCH_LIMIT) return [{ from: start, to: start + oldPart.length, insert: narrow.insert }];
  const [oldPoints, newPoints] = [codePoints(oldPart), codePoints(narrow.insert)];
  const [oldStarts, newStarts] = [offsetsOf(oldPoints), offsetsOf(newPoints)];
  return diffTokens(oldPoints, newPoints, budget, WORD_GAP).map((hunk) => ({
    from: start + (oldStarts[hunk.aFrom] ?? 0),
    to: start + (oldStarts[hunk.aTo] ?? 0),
    insert: narrow.insert.slice(newStarts[hunk.bFrom], newStarts[hunk.bTo]),
  }));
}
