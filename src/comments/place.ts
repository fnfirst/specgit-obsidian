import { BLOCK_ANCHOR_MIN, isBlockAnchor as isBlockLength, locateQuote, looseText, quoteNeedles } from "../shared/anchoring/anchor";

export interface AnchorWords {

  lineStart: number;
  lineEnd: number;

  quotedText: string;

  exactText?: string;
}

export interface Span {
  from: number;
  to: number;
}

export { BLOCK_ANCHOR_MIN };

export const isBlockAnchor = (span: Span): boolean => isBlockLength(span.to - span.from);

const MARKS = /[*_`~]/;
const SPACE = /\s/;

function loosely(text: string, within: Span): { norm: string; at: number[] } {
  let norm = "";
  const at: number[] = [];
  let spaceAt = -1;
  for (let index = within.from; index < within.to; index++) {
    const char = text[index]!;
    if (MARKS.test(char)) continue;
    if (SPACE.test(char)) {
      if (norm !== "" && spaceAt < 0) spaceAt = index;
      continue;
    }
    if (spaceAt >= 0) {
      norm += " ";
      at.push(spaceAt);
      spaceAt = -1;
    }
    norm += char;
    at.push(index);
  }
  return { norm, at };
}

export function findWords(text: string, words: string, within: Span = { from: 0, to: text.length }, near?: number): Span | null {
  const needle = looseText(words);
  if (needle === "") return null;
  const { norm, at } = loosely(text, within);
  let best: { span: Span; gap: number } | null = null;
  for (let index = norm.indexOf(needle); index !== -1; index = norm.indexOf(needle, index + 1)) {
    const span = { from: at[index]!, to: at[index + needle.length - 1]! + 1 };
    const gap = near === undefined ? 0 : Math.abs(span.from - near);
    if (best === null || gap < best.gap) best = { span, gap };
    if (near === undefined || gap === 0) break;
  }
  return best && best.span;
}

export function insideCodeFence(text: string, offset: number): boolean {
  const lines = text.slice(0, offset).split("\n");
  lines.pop();
  return lines.filter((line) => /^ {0,3}(```|~~~)/.test(line)).length % 2 === 1;
}

function lineSpans(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const line of text.split("\n")) {
    spans.push({ from, to: from + line.length });
    from += line.length + 1;
  }
  return spans;
}

const withoutCarriageReturn = (line: string): string => line.replace(/\r$/, "");

export function locateLines(text: string, anchor: AnchorWords): { lineStart: number; lineEnd: number } | null {
  const lines = text.split("\n");
  const quoted = anchor.quotedText.split("\n").map(withoutCarriageReturn);
  if (quoted.join("") === "") return null;
  let best: { lineStart: number; gap: number } | null = null;
  for (let start = 0; start + quoted.length <= lines.length; start++) {
    if (!quoted.every((line, offset) => lines[start + offset] === line)) continue;
    const gap = Math.abs(start + 1 - anchor.lineStart);
    if (best === null || gap < best.gap) best = { lineStart: start + 1, gap };
    if (gap === 0) break;
  }
  if (best) return { lineStart: best.lineStart, lineEnd: best.lineStart + quoted.length - 1 };
  return locateQuote(text, anchor.quotedText, { lineStart: anchor.lineStart, lineEnd: anchor.lineEnd });
}

function regionOf(spans: Span[], lines: { lineStart: number; lineEnd: number }): Span {
  return { from: spans[lines.lineStart - 1]!.from, to: spans[Math.min(lines.lineEnd, spans.length) - 1]!.to };
}

function trimmed(text: string, span: Span): Span | null {
  let { from, to } = span;
  while (from < to && SPACE.test(text[from]!)) from++;
  while (to > from && SPACE.test(text[to - 1]!)) to--;
  return to > from ? { from, to } : null;
}

const narrowWords = (anchor: AnchorWords): string | null => {
  const words = anchor.exactText?.trim();
  return words ? words : null;
};

export function placeMark(text: string, anchor: AnchorWords): Span | null {
  const lines = locateLines(text, anchor);
  const words = narrowWords(anchor);
  if (lines) {
    const region = regionOf(lineSpans(text), lines);
    return (words && findWords(text, words, region)) || trimmed(text, region);
  }
  const near = lineSpans(text)[Math.min(anchor.lineStart, text.split("\n").length) - 1]?.from;
  const quote = words ?? anchor.quotedText;
  for (const needle of quoteNeedles(quote)) {
    const found = findWords(text, needle, undefined, near);
    if (found) return found;
  }
  return null;
}

export function placeEdit(text: string, anchor: AnchorWords): Span | null {
  const lines = locateLines(text, anchor);
  if (!lines) return null;
  const region = regionOf(lineSpans(text), lines);
  const words = narrowWords(anchor);
  return words ? findWords(text, words, region) : region;
}
