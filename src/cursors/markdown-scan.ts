export interface Needle {
  readonly head: number;
  readonly tail: number | null;
}

export type ScanDir = 1 | -1;

export interface Region {
  from: number;
  to: number;
  table?: boolean;
}

export interface ScanBudget {
  remaining: number;
}

const MAX_SYNTAX_SPAN = 2048;

export const isSpace = (unit: number): boolean => unit <= 32;
export const isHorizontalSpace = (unit: number): boolean => unit === 32 || unit === 9;
export const isLineBreak = (unit: number): boolean => unit === 10 || unit === 13;
const isAsciiAlpha = (unit: number): boolean => (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122);
const isTagNameChar = (unit: number): boolean => isAsciiAlpha(unit) || (unit >= 48 && unit <= 57) || unit === 45;
const isEntityChar = (unit: number): boolean => isAsciiAlpha(unit) || (unit >= 48 && unit <= 57) || unit === 35;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

export const isSkippableSyntax = (unit: number): boolean =>
  unit <= 32 ||
  unit === 0xa0 ||
  (unit >= 33 && unit <= 47) ||
  (unit >= 58 && unit <= 64) ||
  (unit >= 91 && unit <= 96) ||
  (unit >= 123 && unit <= 126) ||
  (unit >= 0x2000 && unit <= 0x206f);

const charMatches = (unit: number, wanted: number, allowLineBreak = true): boolean =>
  isSpace(wanted) ? isSpace(unit) && (allowLineBreak || !isLineBreak(unit)) : unit === wanted;

export function trimmedEnd(value: string): number {
  let end = value.length;
  while (end > 0 && isHorizontalSpace(value.charCodeAt(end - 1))) end--;
  return end;
}

const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BLANK_QUOTE = /^(?: {0,3}>[ \t]*)+$/;
const QUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/;
const TABLE_DELIMITER = /^[ \t]*(?:\|[ \t]*:?-+:?[ \t]*\|?|:?-+:?[ \t]*\|[ \t]*:?-+:?)[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/m;

function indentOf(text: string, from: number, to: number): { at: number; col: number } {
  let at = from;
  let col = 0;
  while (at < to) {
    const ch = text.charCodeAt(at);
    if (ch === 32) col++;
    else if (ch === 9) col += 4 - (col % 4);
    else break;
    at++;
  }
  return { at, col };
}

function columnWidth(text: string, len: number): number {
  let col = 0;
  for (let i = 0; i < len; i++) {
    col += text.charCodeAt(i) === 9 ? 4 - (col % 4) : 1;
  }
  return col;
}

export function frontMatterEnd(markdown: string): number {
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

export function listMarkerEnd(markdown: string, line: number, end: number): number | null {
  const sample = markdown.slice(line, Math.min(end, line + 200));
  const quote = QUOTE_PREFIX.exec(sample);
  const offset = quote ? quote[0].length : 0;
  const marker = LIST_MARKER.exec(sample.slice(offset));
  return marker ? line + offset + marker[0].length : null;
}

function fenceOf(markdown: string, from: number, to: number, maxIndent = 3): { unit: number; size: number; after: number; col: number } | null {
  const { at, col } = indentOf(markdown, from, to);
  if (col > maxIndent || at >= to) return null;
  const unit = markdown.charCodeAt(at);
  if (unit !== 96 && unit !== 126) return null;
  let size = 0;
  while (at + size < to && markdown.charCodeAt(at + size) === unit) size++;
  if (size < 3) return null;
  if (unit === 96) {
    for (let i = at + size; i < to; i++) if (markdown.charCodeAt(i) === 96) return null;
  }
  return { unit, size, after: at + size, col };
}

function closesFence(markdown: string, from: number, to: number, open: { unit: number; size: number }, maxIndent = 3): boolean {
  const fence = fenceOf(markdown, from, to, maxIndent);
  if (!fence || fence.unit !== open.unit || fence.size < open.size) return false;
  for (let at = fence.after; at < to; at++) {
    if (!isHorizontalSpace(markdown.charCodeAt(at))) return false;
  }
  return true;
}

export function regionsOf(markdown: string, start: number): Region[] {
  const regions: Region[] = [];
  let open: Region | null = null;
  let fence: { unit: number; size: number; quoted: boolean; maxClose: number } | null = null;
  let inList = false;
  for (let at = start; at < markdown.length; ) {
    let end = markdown.indexOf("\n", at);
    if (end < 0) end = markdown.length;
    const lineEnd = end > at && markdown.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const line = markdown.slice(at, lineEnd);
    let blank = true;
    for (let i = 0; i < line.length && blank; i++) blank = isSpace(line.charCodeAt(i));
    if (fence) {
      const checkLine = fence.quoted ? line.replace(QUOTE_PREFIX, "") : line;
      if (closesFence(checkLine, 0, checkLine.length, fence, fence.maxClose)) {
        fence = null;
        open = null;
        inList = false;
        at = end + 1;
        continue;
      }
    } else if (blank || BLANK_QUOTE.test(line)) {
      open = null;
      inList = false;
      at = end + 1;
      continue;
    } else {
      const stripped = line.replace(QUOTE_PREFIX, "");
      const quoted = stripped !== line;
      const indentedCode = !inList && indentOf(stripped, 0, stripped.length).col >= 4;
      const listMatch = indentedCode ? null : LIST_MARKER.exec(stripped);
      const listLine = listMatch !== null;
      const fenceProbe = listMatch ? stripped.slice(listMatch[0].length) : stripped;
      const newFence = indentedCode ? null : fenceOf(fenceProbe, 0, fenceProbe.length, inList || listLine ? Infinity : 3);
      if (newFence) {
        const maxClose = listMatch
          ? columnWidth(stripped, listMatch[0].length) + newFence.col + 3
          : inList
            ? newFence.col + 3
            : 3;
        fence = { unit: newFence.unit, size: newFence.size, quoted, maxClose };
        open = null;
        inList = false;
        at = end + 1;
        continue;
      }
      if (!indentedCode && ATX_HEADING.test(stripped)) {
        regions.push({ from: at, to: lineEnd });
        open = null;
        inList = false;
        at = end + 1;
        continue;
      }
      if (listLine && !inList) {
        open = null;
        inList = true;
      }
    }
    if (!open) {
      open = { from: at, to: lineEnd };
      regions.push(open);
    }
    if (!open.table && TABLE_DELIMITER.test(line)) open.table = true;
    open.to = lineEnd;
    at = end + 1;
  }
  return regions;
}

export function listItemEnd(markdown: string, start: number, end: number): number {
  let fence: { unit: number; size: number; maxClose: number } | null = null;
  for (let nl = markdown.indexOf("\n", start); nl >= 0 && nl < end; nl = markdown.indexOf("\n", nl + 1)) {
    const lineStart = nl + 1;
    let lineEnd = markdown.indexOf("\n", lineStart);
    if (lineEnd < 0 || lineEnd > end) lineEnd = end;
    if (lineEnd > lineStart && markdown.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    const line = markdown.slice(lineStart, lineEnd);
    const stripped = line.replace(QUOTE_PREFIX, "");
    if (fence) {
      if (closesFence(stripped, 0, stripped.length, fence, fence.maxClose)) fence = null;
    } else {
      const opened = fenceOf(stripped, 0, stripped.length, Infinity);
      if (opened) {
        fence = { unit: opened.unit, size: opened.size, maxClose: opened.col + 3 };
      } else if (listMarkerEnd(markdown, lineStart, end) !== null) {
        return nl;
      }
    }
  }
  return end;
}

function matchesNeedleAt(markdown: string, needle: Needle, at: number, limit: number, end: number, dir: ScanDir, allowLineBreak: boolean): number {
  if (needle.tail !== null) {
    const start = dir === 1 ? at : at - 1;
    return start >= limit && start + 1 < end && markdown.charCodeAt(start) === needle.head && markdown.charCodeAt(start + 1) === needle.tail ? start : -1;
  }
  return charMatches(markdown.charCodeAt(at), needle.head, allowLineBreak) ? at : -1;
}

function boundedEnd(at: number, end: number, budget?: ScanBudget): number {
  const maxSpan = budget ? Math.min(MAX_SYNTAX_SPAN, Math.max(0, budget.remaining)) : MAX_SYNTAX_SPAN;
  return Math.min(end, at + maxSpan);
}

function skipLinkDestForward(markdown: string, at: number, end: number, budget?: ScanBudget): number | null {
  const scanEnd = boundedEnd(at, end, budget);
  let p = at + 2;
  while (p < scanEnd && isHorizontalSpace(markdown.charCodeAt(p))) p++;
  if (p >= scanEnd) {
    if (budget) budget.remaining -= p - at;
    return null;
  }
  let closed = false;
  if (markdown.charCodeAt(p) === 60) {
    p++;
    while (p < scanEnd) {
      const ch = markdown.charCodeAt(p);
      if (isLineBreak(ch)) {
        if (budget) budget.remaining -= p - at;
        return null;
      }
      if (ch === 92 && p + 1 < scanEnd && !isLineBreak(markdown.charCodeAt(p + 1))) {
        p += 2;
        continue;
      }
      p++;
      if (ch === 62) break;
    }
    if (markdown.charCodeAt(p - 1) !== 62) {
      if (budget) budget.remaining -= p - at;
      return null;
    }
  } else {
    let depth = 1;
    while (p < scanEnd) {
      const ch = markdown.charCodeAt(p);
      if (isLineBreak(ch)) {
        if (budget) budget.remaining -= p - at;
        return null;
      }
      if (isHorizontalSpace(ch)) break;
      if (ch === 92 && p + 1 < scanEnd && !isLineBreak(markdown.charCodeAt(p + 1))) {
        p += 2;
        continue;
      }
      p++;
      if (ch === 40) depth++;
      else if (ch === 41 && --depth === 0) {
        closed = true;
        break;
      }
    }
  }
  if (closed) {
    if (budget) budget.remaining -= p - at;
    return p;
  }
  while (p < scanEnd && isHorizontalSpace(markdown.charCodeAt(p))) p++;
  if (p >= scanEnd) {
    if (budget) budget.remaining -= p - at;
    return null;
  }
  const quote = markdown.charCodeAt(p);
  if (quote === 41) {
    if (budget) budget.remaining -= p + 1 - at;
    return p + 1;
  }
  if (quote === 34 || quote === 39 || quote === 40) {
    const closeQuote = quote === 40 ? 41 : quote;
    p++;
    while (p < scanEnd) {
      const ch = markdown.charCodeAt(p);
      if (isLineBreak(ch)) {
        if (budget) budget.remaining -= p - at;
        return null;
      }
      if (ch === 92 && p + 1 < scanEnd && !isLineBreak(markdown.charCodeAt(p + 1))) {
        p += 2;
        continue;
      }
      p++;
      if (ch === closeQuote) break;
    }
    if (markdown.charCodeAt(p - 1) !== closeQuote) {
      if (budget) budget.remaining -= p - at;
      return null;
    }
    while (p < scanEnd && isHorizontalSpace(markdown.charCodeAt(p))) p++;
    if (p < scanEnd && markdown.charCodeAt(p) === 41) {
      if (budget) budget.remaining -= p + 1 - at;
      return p + 1;
    }
  }
  if (budget) budget.remaining -= p - at;
  return null;
}

function skipBackwardBy(
  markdown: string,
  at: number,
  limit: number,
  openUnit: number,
  prevUnit: number | null,
  forward: (md: string, start: number, end: number) => number | null,
  budget?: ScanBudget,
  stopOnUnescaped?: number,
): number | null {
  if (budget && budget.remaining <= 0) return null;
  const maxSpan = budget ? Math.min(MAX_SYNTAX_SPAN, budget.remaining) : MAX_SYNTAX_SPAN;
  const minPos = Math.max(prevUnit !== null ? limit + 1 : limit, at - maxSpan);
  let checks = 0;
  let scanned = 0;
  for (let p = at - 1; p >= minPos; p--) {
    scanned++;
    const ch = markdown.charCodeAt(p);
    if (isLineBreak(ch)) break;
    if (stopOnUnescaped !== undefined && ch === stopOnUnescaped && (p === 0 || markdown.charCodeAt(p - 1) !== 92)) break;
    if (ch !== openUnit) continue;
    if (prevUnit !== null && markdown.charCodeAt(p - 1) !== prevUnit) continue;
    const start = prevUnit !== null ? p - 1 : p;
    if (++checks > 8) break;
    scanned += at + 1 - start;
    if (forward(markdown, start, at + 1) === at + 1) {
      if (budget) budget.remaining -= scanned;
      return start - 1;
    }
  }
  if (budget) budget.remaining -= scanned;
  return null;
}

function skipLinkDestBackward(markdown: string, at: number, limit: number, budget?: ScanBudget): number | null {
  return skipBackwardBy(markdown, at, limit, 40, 93, skipLinkDestForward, budget);
}

function skipRefLabelForward(markdown: string, at: number, end: number, budget?: ScanBudget): number | null {
  const scanEnd = boundedEnd(at, end, budget);
  let p = at + 2;
  for (; p < scanEnd; ) {
    const ch = markdown.charCodeAt(p);
    if (isLineBreak(ch) || ch === 91) {
      if (budget) budget.remaining -= p - at;
      return null;
    }
    if (ch === 92 && p + 1 < scanEnd && !isLineBreak(markdown.charCodeAt(p + 1))) {
      p += 2;
      continue;
    }
    p++;
    if (ch === 93) {
      if (budget) budget.remaining -= p - at;
      return p;
    }
  }
  if (budget) budget.remaining -= p - at;
  return null;
}

function skipRefLabelBackward(markdown: string, at: number, limit: number, budget?: ScanBudget): number | null {
  return skipBackwardBy(markdown, at, limit, 91, 93, skipRefLabelForward, budget, 93);
}

function skipHtmlTagForward(markdown: string, at: number, end: number, budget?: ScanBudget): number | null {
  const scanEnd = boundedEnd(at, end, budget);
  if (at + 2 >= scanEnd || markdown.charCodeAt(at) !== 60) return null;
  if (markdown.startsWith("<!--", at)) {
    let p = at + 4;
    for (; p + 2 < scanEnd; p++) {
      if (isLineBreak(markdown.charCodeAt(p))) {
        if (budget) budget.remaining -= p - at;
        return null;
      }
      if (markdown.charCodeAt(p) === 45 && markdown.charCodeAt(p + 1) === 45 && markdown.charCodeAt(p + 2) === 62) {
        if (budget) budget.remaining -= p + 3 - at;
        return p + 3;
      }
    }
    if (budget) budget.remaining -= p - at;
    return null;
  }
  let p = at + 1;
  const closing = markdown.charCodeAt(p) === 47;
  if (closing) p++;
  if (p >= scanEnd || !isAsciiAlpha(markdown.charCodeAt(p))) return null;
  p++;
  while (p < scanEnd && isTagNameChar(markdown.charCodeAt(p))) p++;
  if (p >= scanEnd) {
    if (budget) budget.remaining -= p - at;
    return null;
  }
  const delim = markdown.charCodeAt(p);
  if (closing) {
    while (p < scanEnd && isHorizontalSpace(markdown.charCodeAt(p))) p++;
    const matched = p < scanEnd && markdown.charCodeAt(p) === 62;
    if (budget) budget.remaining -= p + (matched ? 1 : 0) - at;
    return matched ? p + 1 : null;
  }
  if (delim === 62) {
    if (budget) budget.remaining -= p + 1 - at;
    return p + 1;
  }
  if (delim === 47) {
    const matched = p + 1 < scanEnd && markdown.charCodeAt(p + 1) === 62;
    if (budget) budget.remaining -= p + (matched ? 2 : 1) - at;
    return matched ? p + 2 : null;
  }
  if (!isHorizontalSpace(delim)) {
    if (budget) budget.remaining -= p - at;
    return null;
  }
  let quote = 0;
  for (; p < scanEnd; p++) {
    const ch = markdown.charCodeAt(p);
    if (isLineBreak(ch)) {
      if (budget) budget.remaining -= p - at;
      return null;
    }
    if (quote !== 0) {
      if (ch === quote) quote = 0;
      continue;
    }
    if (ch === 34 || ch === 39) {
      quote = ch;
    } else if (ch === 62) {
      if (budget) budget.remaining -= p + 1 - at;
      return p + 1;
    }
  }
  if (budget) budget.remaining -= p - at;
  return null;
}

function skipHtmlTagBackward(markdown: string, at: number, limit: number, budget?: ScanBudget): number | null {
  return skipBackwardBy(markdown, at, limit, 60, null, skipHtmlTagForward, budget);
}

function skipHtmlEntityForward(markdown: string, at: number, end: number): number | null {
  let p = at;
  while (p < end && p - at < 16 && isEntityChar(markdown.charCodeAt(p))) p++;
  return p > at && p < end && markdown.charCodeAt(p) === 59 ? p + 1 : null;
}

function skipHtmlEntityBackward(markdown: string, at: number, limit: number): number | null {
  let p = at - 1;
  while (p >= limit && at - p <= 16 && isEntityChar(markdown.charCodeAt(p))) p--;
  return p < at - 1 && p >= limit && markdown.charCodeAt(p) === 38 ? p : null;
}

function skipComplexSyntax(
  markdown: string,
  at: number,
  limit: number,
  end: number,
  dir: ScanDir,
  budget?: ScanBudget,
): number | null {
  if (budget && budget.remaining <= 0) return null;
  const unit = markdown.charCodeAt(at);
  if (dir === 1) {
    if (unit === 93 && at + 1 < end) {
      const next = markdown.charCodeAt(at + 1);
      if (next === 40) return skipLinkDestForward(markdown, at, end, budget);
      if (next === 91) return skipRefLabelForward(markdown, at, end, budget);
    }
    if (unit === 60) return skipHtmlTagForward(markdown, at, end, budget);
    if (at > limit && markdown.charCodeAt(at - 1) === 38) return skipHtmlEntityForward(markdown, at, end);
    return null;
  }
  if (unit === 41) return skipLinkDestBackward(markdown, at, limit, budget);
  if (unit === 93) return skipRefLabelBackward(markdown, at, limit, budget);
  if (unit === 62) return skipHtmlTagBackward(markdown, at, limit, budget);
  if (unit === 59) return skipHtmlEntityBackward(markdown, at, limit);
  return null;
}

export function readNeedle(value: string, index: number, dir: ScanDir, min = 0): { needle: Needle; next: number } {
  const unit = value.charCodeAt(index);
  if (dir === 1 && index + 1 < value.length && isHighSurrogate(unit) && isLowSurrogate(value.charCodeAt(index + 1))) {
    return { needle: { head: unit, tail: value.charCodeAt(index + 1) }, next: index + 2 };
  }
  if (dir === -1 && index - 1 >= min && isLowSurrogate(unit) && isHighSurrogate(value.charCodeAt(index - 1))) {
    return { needle: { head: value.charCodeAt(index - 1), tail: unit }, next: index - 2 };
  }
  return { needle: { head: unit, tail: null }, next: index + dir };
}

function skipSyntax(
  markdown: string,
  at: number,
  limit: number,
  end: number,
  dir: ScanDir,
  allowLineBreak = true,
  budget?: ScanBudget,
): number | null {
  const unit = markdown.charCodeAt(at);
  if (!allowLineBreak && isLineBreak(unit)) return null;
  return skipComplexSyntax(markdown, at, limit, end, dir, budget) ?? (isSkippableSyntax(unit) ? at + dir : null);
}

export function scanInSyntax(
  markdown: string,
  needle: Needle,
  from: number,
  limit: number,
  end: number,
  dir: ScanDir,
  allowLineBreak = true,
  budget?: ScanBudget,
): { hit: number; stoppedAt: number; complex: boolean } {
  let complex = false;
  let at = dir === 1 ? from : from - 1;
  for (; dir === 1 ? at < end : at >= limit; ) {
    const hit = matchesNeedleAt(markdown, needle, at, limit, end, dir, allowLineBreak);
    if (hit >= 0) return { hit, stoppedAt: at, complex };
    const unit = markdown.charCodeAt(at);
    if (!allowLineBreak && isLineBreak(unit)) return { hit: -1, stoppedAt: at, complex };
    const jumped = skipComplexSyntax(markdown, at, limit, end, dir, budget);
    if (jumped !== null) {
      complex = true;
      at = jumped;
    } else if (isSkippableSyntax(unit)) {
      at += dir;
    } else {
      return { hit: -1, stoppedAt: at, complex };
    }
  }
  return { hit: -1, stoppedAt: at, complex };
}

export function findInSyntax(
  markdown: string,
  needle: Needle,
  from: number,
  limit: number,
  end: number,
  dir: ScanDir,
  allowLineBreak = true,
  budget?: ScanBudget,
): number {
  return scanInSyntax(markdown, needle, from, limit, end, dir, allowLineBreak, budget).hit;
}

export function stepForward(
  markdown: string,
  value: string,
  index: number,
  trimmedLen: number,
  rejectTrailingLineBreak: boolean,
  from: number,
  limit: number,
  end: number,
  budget?: ScanBudget,
): { hit: number; next: number } | null {
  const { needle, next } = readNeedle(value, index, 1);
  const allowLineBreak = !rejectTrailingLineBreak || index < trimmedLen || isLineBreak(needle.head);
  const hit = findInSyntax(markdown, needle, from, limit, end, 1, allowLineBreak, budget);
  return hit < 0 ? null : { hit, next };
}

export function findRunStart(markdown: string, needle: Needle, from: number, end: number, allowLineBreak: boolean, budget?: ScanBudget): number {
  for (let at = from; at < end; ) {
    const hit = matchesNeedleAt(markdown, needle, at, from, end, 1, allowLineBreak);
    if (hit >= 0) return hit;
    const skipped =
      skipComplexSyntax(markdown, at, from, end, 1, budget) ??
      (markdown.charCodeAt(at) === 38 ? skipHtmlEntityForward(markdown, at + 1, end) : null);
    at = skipped !== null && skipped > at ? skipped : at + 1;
  }
  return -1;
}

export function reachesEnd(markdown: string, from: number, end: number, limit: number): boolean {
  const budget: ScanBudget = { remaining: Math.max(4096, (end - limit) * 4) };
  for (let at = from; at < end; ) {
    if (isLineBreak(markdown.charCodeAt(at))) return true;
    const next = skipSyntax(markdown, at, limit, end, 1, false, budget);
    if (next === null || next <= at) return false;
    at = next;
  }
  return true;
}
