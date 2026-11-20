import * as Y from "yjs";
import { isAtom, type TextRun, type TreeRun } from "./tree-index";

interface PartialMatch {
  readonly prefixOffsets: readonly number[];
  readonly prefixEnd: number;
  readonly suffixOffsets: readonly number[];
  readonly suffixStart: number;
}

interface Placement {
  readonly run: TreeRun;
  readonly from: number;
  readonly to: number;
  readonly partial?: PartialMatch;
}

interface Needle {
  readonly head: number;
  readonly tail: number | null;
}

type ScanDir = 1 | -1;
type ListRole = "start" | "inside" | null;

export interface TreePoint {
  node: Y.XmlText | Y.XmlElement;
  index: number;
  assoc: number;
}

interface Region {
  from: number;
  to: number;
}

const LOOKAHEAD = 24;

const isSpace = (unit: number): boolean => unit <= 32;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

const isSkippableSyntax = (unit: number): boolean =>
  unit <= 32 ||
  unit === 0xa0 ||
  (unit >= 33 && unit <= 47) ||
  (unit >= 58 && unit <= 64) ||
  (unit >= 91 && unit <= 96) ||
  (unit >= 123 && unit <= 126) ||
  (unit >= 0x2000 && unit <= 0x206f);

const charMatches = (unit: number, wanted: number): boolean => (isSpace(wanted) ? isSpace(unit) : unit === wanted);

function frontMatterEnd(markdown: string): number {
  if (!markdown.startsWith("---")) return 0;
  let at = markdown.indexOf("\n");
  if (at < 0 || markdown.slice(0, at).trim() !== "---") return 0;
  for (at++; at <= markdown.length; ) {
    let end = markdown.indexOf("\n", at);
    if (end < 0) end = markdown.length;
    const line = markdown.slice(at, end).trim();
    if (line === "---" || line === "...") return Math.min(end + 1, markdown.length);
    if (end === markdown.length) return 0;
    at = end + 1;
  }
  return 0;
}

function fenceOf(markdown: string, from: number, to: number): { unit: number; size: number } | null {
  let at = from;
  while (at < to && at - from < 3 && markdown.charCodeAt(at) === 32) at++;
  const unit = markdown.charCodeAt(at);
  if (unit !== 96 && unit !== 126) return null;
  let size = 0;
  while (at + size < to && markdown.charCodeAt(at + size) === unit) size++;
  return size >= 3 ? { unit, size } : null;
}

function closesFence(markdown: string, from: number, to: number, open: { unit: number; size: number }): boolean {
  const fence = fenceOf(markdown, from, to);
  if (!fence || fence.unit !== open.unit || fence.size < open.size) return false;
  for (let at = from; at < to; at++) {
    const unit = markdown.charCodeAt(at);
    if (unit !== open.unit && !isSpace(unit)) return false;
  }
  return true;
}

function regionsOf(markdown: string, start: number): Region[] {
  const regions: Region[] = [];
  let open: Region | null = null;
  let fence: { unit: number; size: number } | null = null;
  for (let at = start; at < markdown.length; ) {
    let end = markdown.indexOf("\n", at);
    if (end < 0) end = markdown.length;
    const lineEnd = end > at && markdown.charCodeAt(end - 1) === 13 ? end - 1 : end;
    let blank = true;
    for (let i = at; i < lineEnd && blank; i++) blank = isSpace(markdown.charCodeAt(i));
    if (fence) {
      if (closesFence(markdown, at, lineEnd, fence)) fence = null;
    } else if (blank) {
      open = null;
    } else {
      fence = fenceOf(markdown, at, lineEnd);
    }
    if (!blank || fence) {
      if (!open) {
        open = { from: at, to: lineEnd };
        regions.push(open);
      }
      open.to = lineEnd;
    }
    at = end + 1;
  }
  return regions;
}

export function find(markdown: string, wanted: number, from: number, end: number): number {
  const space = isSpace(wanted);
  for (let at = from; at < end; at++) {
    const unit = markdown.charCodeAt(at);
    if (space ? isSpace(unit) : unit === wanted) return at;
  }
  return -1;
}

function match(markdown: string, value: string, start: number, end: number): { first: number; last: number } | null {
  let at = start;
  let first = -1;
  for (let i = 0; i < value.length; i++) {
    at = find(markdown, value.charCodeAt(i), at, end);
    if (at < 0) return null;
    if (i === 0) first = at;
    at++;
  }
  return { first, last: at };
}

function skipLinkDestForward(markdown: string, at: number, end: number): number | null {
  let depth = 1;
  for (let p = at + 2; p < end; p++) {
    const ch = markdown.charCodeAt(p);
    if (isSpace(ch)) return null;
    if (ch === 40) depth++;
    else if (ch === 41 && --depth === 0) return p + 1;
  }
  return null;
}

function skipLinkDestBackward(markdown: string, at: number, limit: number): number | null {
  let depth = 1;
  for (let p = at - 1; p >= limit; p--) {
    const ch = markdown.charCodeAt(p);
    if (isSpace(ch)) return null;
    if (ch === 41) depth++;
    else if (ch === 40 && --depth === 0) return p > limit && markdown.charCodeAt(p - 1) === 93 ? p - 2 : null;
  }
  return null;
}

function readNeedle(value: string, index: number, dir: ScanDir, min = 0): { needle: Needle; next: number } {
  const unit = value.charCodeAt(index);
  if (dir === 1 && index + 1 < value.length && isHighSurrogate(unit) && isLowSurrogate(value.charCodeAt(index + 1))) {
    return { needle: { head: unit, tail: value.charCodeAt(index + 1) }, next: index + 2 };
  }
  if (dir === -1 && index - 1 >= min && isLowSurrogate(unit) && isHighSurrogate(value.charCodeAt(index - 1))) {
    return { needle: { head: value.charCodeAt(index - 1), tail: unit }, next: index - 2 };
  }
  return { needle: { head: unit, tail: null }, next: index + dir };
}

function skipSyntax(markdown: string, at: number, limit: number, end: number, dir: ScanDir): number | null {
  const unit = markdown.charCodeAt(at);
  if (dir === 1 && unit === 93 && at + 1 < end && markdown.charCodeAt(at + 1) === 40) {
    const after = skipLinkDestForward(markdown, at, end);
    if (after !== null) return after;
  } else if (dir === -1 && unit === 41) {
    const before = skipLinkDestBackward(markdown, at, limit);
    if (before !== null) return before;
  }
  return isSkippableSyntax(unit) ? at + dir : null;
}

function findInSyntax(markdown: string, needle: Needle, from: number, limit: number, end: number, dir: ScanDir): number {
  for (let at = dir === 1 ? from : from - 1; dir === 1 ? at < end : at >= limit; ) {
    if (needle.tail !== null) {
      const start = dir === 1 ? at : at - 1;
      if (start >= limit && start + 1 < end && markdown.charCodeAt(start) === needle.head && markdown.charCodeAt(start + 1) === needle.tail) return start;
    } else if (charMatches(markdown.charCodeAt(at), needle.head)) {
      return at;
    }
    const next = skipSyntax(markdown, at, limit, end, dir);
    if (next === null) return -1;
    at = next;
  }
  return -1;
}

function listItemEnd(markdown: string, start: number, end: number): number {
  for (let nl = markdown.indexOf("\n", start); nl >= 0 && nl < end; nl = markdown.indexOf("\n", nl + 1)) {
    if (LIST_MARKER.test(markdown.slice(nl + 1, Math.min(end, nl + 201)))) return nl;
  }
  return end;
}

function hasReliablePartialMatch(value: string, prefixLen: number, suffixLen: number, windowLen: number): boolean {
  const trimmedLen = value.trimEnd().length;
  const onlyTrailingWhitespace = trimmedLen > 0 && trimmedLen < value.length && prefixLen >= trimmedLen;
  if (onlyTrailingWhitespace) return true;
  const matched = prefixLen + suffixLen;
  const shorter = Math.min(value.length, windowLen);
  return matched >= 2 && (matched >= 4 || matched * 2 >= shorter);
}

function matchPartial(markdown: string, run: TextRun, start: number, end: number): Placement | null {
  const value = run.value;
  const prefixOffsets: number[] = [];
  let cursor = start;
  for (let i = 0; i < value.length; ) {
    const { needle, next } = readNeedle(value, i, 1);
    const hit = findInSyntax(markdown, needle, cursor, start, end, 1);
    if (hit < 0) break;
    if (needle.tail !== null) {
      prefixOffsets.push(hit, hit + 1);
      cursor = hit + 2;
    } else {
      prefixOffsets.push(hit);
      cursor = hit + 1;
    }
    i = next;
  }
  const prefixLimit = prefixOffsets.length > 0 ? prefixOffsets[prefixOffsets.length - 1]! + 1 : start;

  const suffixReversed: number[] = [];
  let tailCursor = end;
  for (let j = value.length - 1; j >= prefixOffsets.length; ) {
    const { needle, next } = readNeedle(value, j, -1, prefixOffsets.length);
    const hit = findInSyntax(markdown, needle, tailCursor, prefixLimit, end, -1);
    if (hit < 0) break;
    if (needle.tail !== null) {
      suffixReversed.push(hit + 1, hit);
    } else {
      suffixReversed.push(hit);
    }
    tailCursor = hit;
    j = next;
  }
  const suffixOffsets = suffixReversed.reverse();

  if (!hasReliablePartialMatch(value, prefixOffsets.length, suffixOffsets.length, end - start)) return null;

  const from = prefixOffsets.length > 0 ? prefixOffsets[0]! : suffixOffsets[0]!;
  const suffixStart = suffixOffsets.length > 0 ? suffixOffsets[0]! : prefixLimit;
  const prefixEnd = prefixOffsets.length > 0 ? prefixLimit : suffixStart;
  const to = suffixOffsets.length > 0 ? suffixOffsets[suffixOffsets.length - 1]! + 1 : prefixEnd;
  return { run, from, to, partial: { prefixOffsets, prefixEnd, suffixOffsets, suffixStart } };
}

function partialToText(length: number, to: number, partial: PartialMatch, at: number, assoc: number): number {
  if (at >= length) return to;
  const { prefixOffsets, prefixEnd, suffixOffsets } = partial;
  if (at < prefixOffsets.length) return assoc < 0 && at > 0 ? prefixOffsets[at - 1]! + 1 : prefixOffsets[at]!;
  const suffixFrom = length - suffixOffsets.length;
  if (suffixOffsets.length > 0 && at >= suffixFrom) {
    const j = at - suffixFrom;
    if (assoc < 0) return j === 0 ? prefixEnd : suffixOffsets[j - 1]! + 1;
    return suffixOffsets[j]!;
  }
  return prefixEnd;
}

function partialToTreeIndex(length: number, partial: PartialMatch, offset: number): { value: number; assoc: number } {
  const { prefixOffsets, prefixEnd, suffixOffsets, suffixStart } = partial;
  if (offset <= prefixEnd && prefixOffsets.length > 0) {
    for (let i = 0; i < prefixOffsets.length; i++) {
      if (prefixOffsets[i]! >= offset) return { value: i, assoc: prefixOffsets[i] === offset ? 0 : -1 };
    }
    return { value: prefixOffsets.length, assoc: -1 };
  }
  if (suffixOffsets.length > 0 && offset >= suffixStart) {
    const suffixFrom = length - suffixOffsets.length;
    for (let j = 0; j < suffixOffsets.length; j++) {
      if (suffixOffsets[j]! >= offset) return { value: suffixFrom + j, assoc: suffixOffsets[j] === offset ? 0 : -1 };
    }
    return { value: length, assoc: -1 };
  }
  return { value: prefixOffsets.length, assoc: -1 };
}

function matchAtom(markdown: string, target: string, start: number, end: number): { first: number; last: number } | null {
  for (let at = markdown.indexOf("[[", start); at >= 0 && at < end; at = markdown.indexOf("[[", at + 2)) {
    const close = markdown.indexOf("]]", at + 2);
    if (close < 0 || close + 2 > end) return null;
    const inner = markdown.slice(at + 2, close);
    if (inner.includes("\n")) continue;
    const name = inner.split("|")[0]!.replace(/\\$/, "").trim();
    if (name !== target) continue;
    return { first: markdown[at - 1] === "!" && at > start ? at - 1 : at, last: close + 2 };
  }
  return null;
}

const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

function itemTextStart(markdown: string, base: number, end: number): number {
  let line = base;
  if (base > 0 && markdown.charCodeAt(base - 1) !== 10) {
    const newline = markdown.indexOf("\n", base);
    if (newline < 0 || newline >= end) return base;
    line = newline + 1;
  }
  const marker = LIST_MARKER.exec(markdown.slice(line, Math.min(end, line + 200)));
  return marker ? line + marker[0].length : base;
}

function listRole(run: TreeRun): ListRole {
  const node = isAtom(run) ? run.atom : run.node;
  const paragraph = node.parent;
  if (!(paragraph instanceof Y.XmlElement)) return null;
  const item = paragraph.parent;
  if (!(item instanceof Y.XmlElement) || !/item$/i.test(item.nodeName)) return null;
  return item.get(0) === paragraph && paragraph.get(0) === node ? "start" : "inside";
}

function partialSlices(markdown: string, role: ListRole, from: number, to: number): Region[] {
  if (role === null) return [{ from, to }];
  const slices: Region[] = [];
  let cursor = role === "start" ? itemTextStart(markdown, from, to) : from;
  for (let n = 0; cursor < to && n <= LOOKAHEAD; n++) {
    const end = listItemEnd(markdown, cursor, to);
    if (cursor < end) slices.push({ from: cursor, to: end });
    if (role !== "start" || end >= to) break;
    cursor = itemTextStart(markdown, end + 1, to);
  }
  return slices;
}

function valueIndex(run: TextRun, index: number): number {
  let value = index;
  for (const embed of run.embeds) {
    if (embed >= index) break;
    value--;
  }
  return Math.max(0, value);
}

function nodeIndex(run: TextRun, value: number): number {
  let index = value;
  for (const embed of run.embeds) {
    if (embed > index) break;
    index++;
  }
  return index;
}

export class Alignment {
  private readonly placed: Placement[] = [];
  private readonly byNode = new Map<Y.XmlText | Y.XmlElement, Placement>();
  private readonly bodyStart: number;

  constructor(
    runs: readonly TreeRun[],
    private readonly markdown: string,
  ) {
    this.bodyStart = frontMatterEnd(markdown);
    const regions = regionsOf(markdown, this.bodyStart);
    const slots = new Array<Placement | null>(runs.length).fill(null);
    let current = 0;
    let cursor = this.bodyStart;
    let missed = 0;

    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]!;
      if (run.value === "" && !isAtom(run)) continue;
      const item = listRole(run) === "start";
      let placed = false;
      for (let k = current; k < regions.length && k <= current + LOOKAHEAD; k++) {
        const region = regions[k]!;
        let start = k === current ? Math.max(cursor, region.from) : region.from;
        if (item) start = itemTextStart(markdown, start, region.to);
        const hit = isAtom(run) ? matchAtom(markdown, run.target, start, region.to) : match(markdown, run.value, start, region.to);
        if (!hit) continue;
        current = k;
        cursor = hit.last;
        slots[r] = { run, from: hit.first, to: hit.last };
        placed = true;
        break;
      }
      if (!placed && !isAtom(run)) missed++;
    }

    if (missed > 0 && regions.length > 0) {
      const nextFrom = new Array<number>(runs.length);
      let hi = markdown.length;
      for (let r = runs.length - 1; r >= 0; r--) {
        nextFrom[r] = hi;
        if (slots[r]) hi = slots[r]!.from;
      }
      let lo = this.bodyStart;
      let regionIdx = 0;
      for (let r = 0; r < runs.length; r++) {
        const existing = slots[r];
        if (existing) {
          lo = existing.to;
          continue;
        }
        const run = runs[r]!;
        if (isAtom(run) || run.value === "") continue;
        const boundHi = nextFrom[r]!;
        if (lo >= boundHi) continue;
        while (regionIdx < regions.length && regions[regionIdx]!.to <= lo) regionIdx++;
        const role = listRole(run);
        let checked = 0;
        for (let k = regionIdx; k < regions.length && checked <= LOOKAHEAD; k++) {
          const region = regions[k]!;
          if (region.from >= boundHi) break;
          checked++;
          const regionStart = Math.max(lo, region.from);
          const regionEnd = Math.min(boundHi, region.to);
          if (regionStart >= regionEnd) continue;
          let partial: Placement | null = null;
          for (const slice of partialSlices(markdown, role, regionStart, regionEnd)) {
            partial = matchPartial(markdown, run, slice.from, slice.to);
            if (partial) break;
          }
          if (!partial) continue;
          slots[r] = partial;
          lo = partial.to;
          regionIdx = k;
          break;
        }
      }
    }

    for (const placement of slots) {
      if (!placement) continue;
      this.placed.push(placement);
      this.byNode.set(isAtom(placement.run) ? placement.run.atom : placement.run.node, placement);
    }
  }

  toText(node: Y.XmlText | Y.XmlElement, index: number, assoc = 0): number | null {
    if (node instanceof Y.XmlElement) return this.betweenChildren(node, index);
    const placement = this.byNode.get(node);
    if (!placement || isAtom(placement.run)) return null;
    const at = valueIndex(placement.run, index);
    const length = placement.run.value.length;
    if (placement.partial) return partialToText(length, placement.to, placement.partial, at, assoc);
    if (at >= length) return placement.to;
    return assoc < 0 && at > 0 ? this.offsetOf(placement, at - 1) + 1 : this.offsetOf(placement, at);
  }

  toTree(offset: number): TreePoint | null {
    if (this.placed.length === 0 || offset < this.bodyStart) return null;

    let [low, high] = [0, this.placed.length];
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.placed[mid]!.from <= offset) low = mid + 1;
      else high = mid;
    }
    const placement = this.placed[low - 1];
    if (!placement) return this.point(this.placed[0]!, 0, 0);
    const length = placement.run.value.length;
    if (offset > placement.to) {

      const next = this.placed[low];
      return next && !this.lineBreakBetween(offset, next.from) ? this.point(next, 0, 0) : this.point(placement, length, -1);
    }

    if (isAtom(placement.run)) return this.point(placement, 0, 0, offset - placement.from > placement.to - offset);
    if (placement.partial) {
      const hit = partialToTreeIndex(length, placement.partial, offset);
      return this.point(placement, hit.value, hit.assoc);
    }

    let at = placement.from;
    for (let i = 0; i < length; i++) {
      if (at >= offset) return this.point(placement, i, at === offset ? 0 : -1);
      if (i + 1 < length) at = find(this.markdown, placement.run.value.charCodeAt(i + 1), at + 1, this.markdown.length);
    }
    return this.point(placement, length, -1);
  }

  private point(placement: Placement, value: number, assoc: number, after = false): TreePoint {
    const run = placement.run;
    if (!isAtom(run)) return { node: run.node, index: nodeIndex(run, value), assoc };

    const siblings = run.parent.toArray();
    const at = siblings.indexOf(run.atom);
    const neighbour = siblings[after ? at + 1 : at - 1];
    if (neighbour instanceof Y.XmlText) return after ? { node: neighbour, index: 0, assoc: 0 } : { node: neighbour, index: neighbour.length, assoc: -1 };
    return after ? { node: run.parent, index: at + 1, assoc: -1 } : { node: run.parent, index: at, assoc: 0 };
  }

  private betweenChildren(parent: Y.XmlElement, index: number): number | null {
    const children = parent.toArray();
    const placeOf = (child: unknown): Placement | undefined => (child instanceof Y.XmlText || child instanceof Y.XmlElement ? this.byNode.get(child) : undefined);
    return placeOf(children[index])?.from ?? placeOf(children[index - 1])?.to ?? null;
  }

  private offsetOf(placement: Placement, at: number): number {
    let offset = placement.from;
    for (let i = 1; i <= at; i++) offset = find(this.markdown, placement.run.value.charCodeAt(i), offset + 1, this.markdown.length);
    return offset;
  }

  private lineBreakBetween(from: number, to: number): boolean {
    const at = this.markdown.indexOf("\n", from);
    return at >= 0 && at < to;
  }
}
