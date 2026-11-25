import * as Y from "yjs";
import {
  findInSyntax,
  findRunStart,
  frontMatterEnd,
  isLineBreak,
  isSkippableSyntax,
  isSpace,
  listItemEnd,
  listMarkerEnd,
  reachesEnd,
  readNeedle,
  regionsOf,
  scanInSyntax,
  stepForward,
  trimmedEnd,
  type Region,
  type ScanBudget,
} from "./markdown-scan";
import { isAtom, type TextRun, type TreeRun } from "./tree-index";

interface PartialMatch {
  readonly prefixOffsets: readonly number[];
  readonly prefixEnd: number;
  readonly suffixOffsets: readonly number[];
  readonly suffixStart: number;
  readonly suffixEnd: number;
}

interface Placement {
  readonly run: TreeRun;
  readonly from: number;
  readonly to: number;
  readonly blockEnd: boolean;
  readonly partial?: PartialMatch;
}

type ListRole = "start" | "inside" | null;

export interface TreePoint {
  node: Y.XmlText | Y.XmlElement;
  index: number;
  assoc: number;
}

const LOOKAHEAD = 24;

export function find(markdown: string, wanted: number, from: number, end: number): number {
  const space = isSpace(wanted);
  for (let at = from; at < end; at++) {
    const unit = markdown.charCodeAt(at);
    if (space ? isSpace(unit) : unit === wanted) return at;
  }
  return -1;
}

function match(markdown: string, value: string, start: number, end: number, rejectTrailingLineBreak: boolean): { first: number; last: number } | null {
  if (value.length === 0) return null;
  const trimmedLen = trimmedEnd(value);
  const { needle: headNeedle, next: headNext } = readNeedle(value, 0, 1);
  const headAllowLineBreak = !rejectTrailingLineBreak || 0 < trimmedLen || isLineBreak(headNeedle.head);
  let headRepeat = headNext;
  if (headNeedle.tail === null) {
    if (isSpace(headNeedle.head)) {
      while (headRepeat < value.length && isSpace(value.charCodeAt(headRepeat))) headRepeat++;
    } else {
      while (headRepeat < value.length && value.charCodeAt(headRepeat) === headNeedle.head) headRepeat++;
    }
  }
  let budget = Math.max(512, (end - start) * 4);
  const complexBudget: ScanBudget = { remaining: Math.max(4096, (end - start) * 4) };
  for (let probe = start; end - probe >= value.length; ) {
    const first = findRunStart(markdown, headNeedle, probe, end, headAllowLineBreak, complexBudget);
    if (first < 0 || end - first < value.length) return null;
    budget -= first - probe + 1;
    let at = first + headNext;
    let i = headNext;
    let failStoppedAt = at;
    let failComplex = false;
    while (i < value.length) {
      const { needle, next } = readNeedle(value, i, 1);
      const allowLineBreak = !rejectTrailingLineBreak || i < trimmedLen || isLineBreak(needle.head);
      const scan = scanInSyntax(markdown, needle, at, first, end, 1, allowLineBreak, complexBudget);
      budget -= scan.stoppedAt - at + 1;
      if (scan.hit < 0) {
        failStoppedAt = scan.stoppedAt;
        failComplex = scan.complex;
        break;
      }
      at = scan.hit + (next - i);
      i = next;
    }
    if (i >= value.length) return { first, last: at };
    if (budget <= 0) return null;
    if (
      headNeedle.head > 32 &&
      headRepeat > headNext &&
      i === headRepeat &&
      at - first === i &&
      at < end &&
      markdown.charCodeAt(at) === headNeedle.head
    ) {
      let runEnd = at + 1;
      while (runEnd < end && markdown.charCodeAt(runEnd) === headNeedle.head) runEnd++;
      probe = Math.max(first + headNext, runEnd - headRepeat);
    } else if (i === headNext && !failComplex && failStoppedAt > at) {
      probe = failStoppedAt;
    } else {
      probe = first + headNext;
    }
  }
  return null;
}

function hasReliablePartialMatch(value: string, prefixLen: number, suffixLen: number, windowLen: number): boolean {
  const trimmedLen = trimmedEnd(value);
  const onlyTrailingWhitespace = trimmedLen > 0 && trimmedLen < value.length && prefixLen >= trimmedLen;
  if (onlyTrailingWhitespace) return true;
  const matched = prefixLen + suffixLen;
  const shorter = Math.min(value.length, windowLen);
  return matched >= 2 && (matched >= 4 || matched * 2 >= shorter);
}

function matchPartial(markdown: string, run: TextRun, start: number, end: number, rejectTrailingLineBreak: boolean): Placement | null {
  const value = run.value;
  const trimmedLen = trimmedEnd(value);
  const complexBudget: ScanBudget = { remaining: Math.max(4096, (end - start) * 4) };
  const prefixOffsets: number[] = [];
  let cursor = start;
  for (let i = 0; i < value.length; ) {
    const step = stepForward(markdown, value, i, trimmedLen, rejectTrailingLineBreak, cursor, start, end, complexBudget);
    if (!step) break;
    if (step.next - i === 2) {
      prefixOffsets.push(step.hit, step.hit + 1);
      cursor = step.hit + 2;
    } else {
      prefixOffsets.push(step.hit);
      cursor = step.hit + 1;
    }
    i = step.next;
  }
  const prefixLimit = prefixOffsets.length > 0 ? prefixOffsets[prefixOffsets.length - 1]! + 1 : start;

  const suffixReversed: number[] = [];
  if (prefixOffsets.length < trimmedLen) {
    const suffixBudget: ScanBudget = { remaining: Math.max(4096, (end - prefixLimit) * 4) };
    let tailCursor = end;
    for (let j = trimmedLen - 1; j >= prefixOffsets.length; ) {
      const { needle, next } = readNeedle(value, j, -1, prefixOffsets.length);
      const hit = findInSyntax(markdown, needle, tailCursor, prefixLimit, end, -1, true, suffixBudget);
      if (hit < 0) break;
      if (needle.tail !== null) {
        suffixReversed.push(hit + 1, hit);
      } else {
        suffixReversed.push(hit);
      }
      tailCursor = hit;
      j = next;
    }
    if (suffixReversed.length === 1) {
      const onlyAt = suffixReversed[0]!;
      if (onlyAt > prefixLimit && !isSkippableSyntax(markdown.charCodeAt(onlyAt - 1))) {
        suffixReversed.length = 0;
      }
    }
  }
  if (suffixReversed.length === 0) {
    while (prefixOffsets.length > 0) {
      const last = prefixOffsets[prefixOffsets.length - 1]!;
      if (!isLineBreak(markdown.charCodeAt(last)) || isLineBreak(value.charCodeAt(prefixOffsets.length - 1))) break;
      prefixOffsets.pop();
    }
  }
  const suffixOffsets = suffixReversed.reverse();
  const adjustedPrefixLimit = prefixOffsets.length > 0 ? prefixOffsets[prefixOffsets.length - 1]! + 1 : start;

  if (!hasReliablePartialMatch(value, prefixOffsets.length, suffixOffsets.length, end - start)) return null;

  const from = prefixOffsets.length > 0 ? prefixOffsets[0]! : suffixOffsets[0]!;
  const suffixStart = suffixOffsets.length > 0 ? suffixOffsets[0]! : adjustedPrefixLimit;
  const prefixEnd = prefixOffsets.length > 0 ? adjustedPrefixLimit : suffixStart;
  const to = suffixOffsets.length > 0 ? suffixOffsets[suffixOffsets.length - 1]! + 1 : prefixEnd;
  return { run, from, to, blockEnd: rejectTrailingLineBreak, partial: { prefixOffsets, prefixEnd, suffixOffsets, suffixStart, suffixEnd: trimmedLen } };
}

function partialToText(length: number, to: number, partial: PartialMatch, at: number, assoc: number): number {
  if (at >= length) return to;
  const { prefixOffsets, prefixEnd, suffixOffsets, suffixEnd } = partial;
  if (at < prefixOffsets.length) return assoc < 0 && at > 0 ? prefixOffsets[at - 1]! + 1 : prefixOffsets[at]!;
  const suffixFrom = suffixEnd - suffixOffsets.length;
  if (suffixOffsets.length > 0 && at >= suffixFrom) {
    if (at >= suffixEnd) return to;
    const j = at - suffixFrom;
    if (assoc < 0) return j === 0 ? prefixEnd : suffixOffsets[j - 1]! + 1;
    return suffixOffsets[j]!;
  }
  return prefixEnd;
}

function partialToTreeIndex(length: number, partial: PartialMatch, offset: number): { value: number; assoc: number } {
  const { prefixOffsets, prefixEnd, suffixOffsets, suffixStart, suffixEnd } = partial;
  if (offset <= prefixEnd && prefixOffsets.length > 0) {
    for (let i = 0; i < prefixOffsets.length; i++) {
      if (prefixOffsets[i]! >= offset) return { value: i, assoc: prefixOffsets[i] === offset ? 0 : -1 };
    }
    return { value: prefixOffsets.length, assoc: -1 };
  }
  if (suffixOffsets.length > 0 && offset >= suffixStart) {
    const suffixFrom = suffixEnd - suffixOffsets.length;
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

function itemTextStart(markdown: string, base: number, end: number, requireMarker: boolean): number {
  let line = base;
  if (base > 0 && markdown.charCodeAt(base - 1) !== 10) {
    const newline = markdown.indexOf("\n", base);
    if (newline < 0 || newline >= end) return requireMarker ? end : base;
    line = newline + 1;
  }
  const textAt = listMarkerEnd(markdown, line, end);
  return textAt !== null ? textAt : requireMarker ? end : base;
}

function listInfo(run: TreeRun): { role: ListRole; item: Y.XmlElement | null; inFirstBlock: boolean } {
  const node = isAtom(run) ? run.atom : run.node;
  const block = node.parent;
  if (!(block instanceof Y.XmlElement) || (block.nodeName !== "paragraph" && block.nodeName !== "heading")) {
    return { role: null, item: null, inFirstBlock: false };
  }
  const item = block.parent;
  if (!(item instanceof Y.XmlElement) || !/item$/i.test(item.nodeName)) return { role: null, item: null, inFirstBlock: false };
  const inFirstBlock = item.get(0) === block;
  return { role: inFirstBlock && block.get(0) === node ? "start" : "inside", item, inFirstBlock };
}

function isBlockEnd(run: TreeRun): boolean {
  const node = isAtom(run) ? run.atom : run.node;
  const block = node.parent;
  if (!(block instanceof Y.XmlElement) || (block.nodeName !== "paragraph" && block.nodeName !== "heading")) return false;
  const container = block.parent;
  if (container instanceof Y.XmlElement && (container.nodeName === "tableCell" || container.nodeName === "tableHeader")) return false;
  const children = block.toArray();
  for (let i = children.indexOf(node) + 1; i < children.length; i++) {
    const sibling = children[i];
    if (sibling instanceof Y.XmlText) {
      if (sibling.length > 0) return false;
    } else if (sibling instanceof Y.XmlElement) {
      return false;
    }
  }
  return true;
}

function* listSlices(markdown: string, role: ListRole, from: number, to: number, requireMarker: boolean): Iterable<Region> {
  if (role === null) {
    yield { from, to };
    return;
  }
  let cursor = role === "start" ? itemTextStart(markdown, from, to, requireMarker) : from;
  for (let n = 0; cursor < to && n <= LOOKAHEAD; n++) {
    const end = listItemEnd(markdown, cursor, to);
    if (cursor < end) yield { from: cursor, to: end };
    if (role !== "start" || end >= to) break;
    cursor = itemTextStart(markdown, end + 1, to, requireMarker);
  }
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
    const placedItems = new Set<Y.XmlElement>();
    let current = 0;
    let cursor = this.bodyStart;
    let missed = 0;
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]!;
      if (run.value === "" && !isAtom(run)) continue;
      const { role, item, inFirstBlock } = listInfo(run);
      const effectiveRole = role === "inside" && inFirstBlock && item && !placedItems.has(item) ? "start" : role;
      const blockEnd = isBlockEnd(run);
      let placed = false;
      for (let k = current; k < regions.length && k <= current + LOOKAHEAD; k++) {
        const region = regions[k]!;
        const start = k === current ? Math.max(cursor, region.from) : region.from;
        const enforceEnd = !isAtom(run) && blockEnd && !region.table;
        let hit: { first: number; last: number } | null = null;
        for (const slice of listSlices(markdown, effectiveRole, start, region.to, true)) {
          const candidate = isAtom(run)
            ? matchAtom(markdown, run.target, slice.from, slice.to)
            : match(markdown, run.value, slice.from, slice.to, blockEnd);
          if (candidate && (!enforceEnd || reachesEnd(markdown, candidate.last, slice.to, candidate.first))) {
            hit = candidate;
            break;
          }
        }
        if (!hit) continue;
        current = k;
        cursor = hit.last;
        slots[r] = { run, from: hit.first, to: hit.last, blockEnd };
        if (item && inFirstBlock) placedItems.add(item);
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
        const { role, item, inFirstBlock } = listInfo(run);
        const effectiveRole = role === "inside" && inFirstBlock && item && !placedItems.has(item) ? "start" : role;
        const blockEnd = isBlockEnd(run);
        let checked = 0;
        for (let k = regionIdx; k < regions.length && checked <= LOOKAHEAD; k++) {
          const region = regions[k]!;
          if (region.from >= boundHi) break;
          checked++;
          const regionStart = Math.max(lo, region.from);
          const regionEnd = Math.min(boundHi, region.to);
          if (regionStart >= regionEnd) continue;
          let partial: Placement | null = null;
          for (const slice of listSlices(markdown, effectiveRole, regionStart, regionEnd, false)) {
            partial = matchPartial(markdown, run, slice.from, slice.to, blockEnd);
            if (partial) break;
          }
          if (!partial) continue;
          slots[r] = partial;
          if (item && inFirstBlock) placedItems.add(item);
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
    const value = placement.run.value;
    const trimmedLen = trimmedEnd(value);
    const budget: ScanBudget = { remaining: Math.max(4096, (placement.to - placement.from) * 4) };
    let at = placement.from;
    for (let i = 0; i < length; ) {
      const { needle, next } = readNeedle(value, i, 1);
      if (at >= offset) return this.point(placement, i, at === offset ? 0 : -1);
      if (needle.tail !== null && at + 1 >= offset) return this.point(placement, i + 1, at + 1 === offset ? 0 : -1);
      if (next < length) {
        const step = stepForward(this.markdown, value, next, trimmedLen, placement.blockEnd, at + (next - i), placement.from, placement.to, budget);
        if (!step) break;
        at = step.hit;
      }
      i = next;
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

  private offsetOf(placement: Placement, target: number): number {
    const value = placement.run.value;
    const trimmedLen = trimmedEnd(value);
    const budget: ScanBudget = { remaining: Math.max(4096, (placement.to - placement.from) * 4) };
    let offset = placement.from;
    for (let i = 0; i < target; ) {
      const { next } = readNeedle(value, i, 1);
      if (next > target) return offset + (target - i);
      const step = stepForward(this.markdown, value, next, trimmedLen, placement.blockEnd, offset + (next - i), placement.from, placement.to, budget);
      if (!step) return placement.to;
      offset = step.hit;
      i = next;
    }
    return offset;
  }

  private lineBreakBetween(from: number, to: number): boolean {
    const at = this.markdown.indexOf("\n", from);
    return at >= 0 && at < to;
  }
}
