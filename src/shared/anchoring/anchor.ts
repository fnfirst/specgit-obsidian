import type { Anchor, CommentStrategy, ReanchorResult } from "./types";

const CONTEXT = 32;

export function computeAnchor(
  source: string,
  path: string,
  lineStart: number,
  lineEnd: number,
  commitSha: string,
  exactText?: string,
): Anchor {
  const lines = source.split("\n");
  const start = clamp(lineStart, 1, lines.length);
  const end = clamp(lineEnd, start, lines.length);
  const quotedText = lines.slice(start - 1, end).join("\n");

  const before = lines.slice(0, start - 1).join("\n");
  const after = lines.slice(end).join("\n");
  const trimmedExact = exactText?.trim();
  const keepExact = trimmedExact && trimmedExact.length > 0 && trimmedExact.length < quotedText.trim().length;
  return {
    path,
    lineStart: start,
    lineEnd: end,
    quotedText,
    prefix: before.slice(Math.max(0, before.length - CONTEXT)),
    suffix: after.slice(0, CONTEXT),
    commitSha,
    ...(keepExact ? { exactText: trimmedExact } : {}),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface LineRange {
  lineStart: number;
  lineEnd: number;
}

const MARKDOWN_MARKS = /[*_`~]/g;

export function looseText(text: string): string {
  return text.replace(MARKDOWN_MARKS, "").replace(/\s+/g, " ").trim();
}

export function locateQuote(source: string, quote: string, near: LineRange): LineRange | null {
  const needle = looseText(quote);
  if (needle === "") return null;

  let text = "";
  const pieces: { offset: number; line: number }[] = [];
  source.split("\n").forEach((line, index) => {
    const piece = looseText(line);
    if (piece === "") return;
    if (text !== "") text += " ";
    pieces.push({ offset: text.length, line: index + 1 });
    text += piece;
  });
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pieces[mid]!.offset <= offset) lo = mid;
      else hi = mid - 1;
    }
    return pieces[lo]!.line;
  };

  let best: (LineRange & { gap: number }) | null = null;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const lineStart = lineAt(at);
    const lineEnd = lineAt(at + needle.length - 1);
    const gap = Math.max(0, lineStart - near.lineEnd, near.lineStart - lineEnd);
    if (best === null || gap < best.gap) best = { lineStart, lineEnd, gap };
    if (gap === 0) break;
  }
  return best && { lineStart: best.lineStart, lineEnd: best.lineEnd };
}

export interface QuotedLines extends LineRange {
  exactText: string;
}

export function placeQuote(source: string, input: LineRange & { exactText: string }): QuotedLines | null {
  const quote = looseText(input.exactText);
  if (quote === "") return null;
  const named = computeAnchor(source, "", input.lineStart, input.lineEnd, "");
  if (looseText(named.quotedText).includes(quote)) return { lineStart: named.lineStart, lineEnd: named.lineEnd, exactText: quote };
  const found = locateQuote(source, quote, named);
  return found && { ...found, exactText: quote };
}

export function reanchor(anchor: Anchor, newSource: string): ReanchorResult {
  const lines = newSource.split("\n");

  const exactAtRange = lines.slice(anchor.lineStart - 1, anchor.lineEnd).join("\n");
  if (exactAtRange === anchor.quotedText && anchor.quotedText.length > 0) {
    return { status: "exact", lineStart: anchor.lineStart, lineEnd: anchor.lineEnd, confidence: 1 };
  }

  const occurrences = findOccurrences(lines, anchor.quotedText);
  if (occurrences.length === 1) {
    const occ = occurrences[0]!;
    return { status: "fuzzy", lineStart: occ.start, lineEnd: occ.end, confidence: 0.9 };
  }
  if (occurrences.length > 1) {
    const best = disambiguate(lines, occurrences, anchor);
    if (best) return { status: "fuzzy", lineStart: best.start, lineEnd: best.end, confidence: 0.7 };
    return { status: "outdated", lineStart: anchor.lineStart, lineEnd: anchor.lineEnd, confidence: 0 };
  }

  return { status: "outdated", lineStart: anchor.lineStart, lineEnd: anchor.lineEnd, confidence: 0 };
}

interface Occurrence {
  start: number;
  end: number;
}

function findOccurrences(lines: string[], quoted: string): Occurrence[] {
  if (!quoted) return [];
  const needle = quoted.split("\n");
  const out: Occurrence[] = [];
  for (let i = 0; i <= lines.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) out.push({ start: i + 1, end: i + needle.length });
  }
  return out;
}

const MIN_FUZZY_SCORE = 1.2;
const MIN_FUZZY_MARGIN = 0.3;

function disambiguate(lines: string[], occurrences: Occurrence[], anchor: Anchor): Occurrence | null {
  if (!anchor.prefix && !anchor.suffix) return null;

  const scored = occurrences
    .map((occ) => {
      const before = lines.slice(0, occ.start - 1).join("\n");
      const after = lines.slice(occ.end).join("\n");
      const prefixActual = before.slice(Math.max(0, before.length - anchor.prefix.length));
      const suffixActual = after.slice(0, anchor.suffix.length);
      const score = similarity(prefixActual, anchor.prefix) + similarity(suffixActual, anchor.suffix);
      return { occ, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const runnerUp = scored[1];
  if (best.score < MIN_FUZZY_SCORE) return null;
  if (runnerUp && best.score - runnerUp.score < MIN_FUZZY_MARGIN) return null;
  return best.occ;
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
  return same / max;
}

export function chooseCommentStrategy(
  anchor: Pick<Anchor, "lineStart" | "lineEnd">,
  diffLines: Set<number>,
  fileInDiff: boolean,
): CommentStrategy {
  if (!fileInDiff) return "issue";
  for (let line = anchor.lineStart; line <= anchor.lineEnd; line++) {
    if (diffLines.has(line)) return "line";
  }
  return "file";
}

export const BLOCK_ANCHOR_MIN = 48;

export const isBlockAnchor = (length: number): boolean => length > BLOCK_ANCHOR_MIN;

export function quoteNeedles(quote: string): string[] {
  return [quote, quote.slice(0, Math.max(8, Math.floor(quote.length * 0.6))), quote.split("\n").map((line) => line.trim()).find(Boolean) ?? ""];
}

export function plainQuote(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/[*`]|~~/g, "")
    .replace(/(^|\W)_+|_+(?=\W|$)/g, "$1")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""))
    .join("\n")
    .trim();
}
