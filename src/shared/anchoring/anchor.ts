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
  return locateBy(source, quote, near, looseText);
}

export function locateWords(source: string, quote: string, near: LineRange): LineRange | null {
  return locateBy(source, quote, near, wordsOf);
}

function locateBy(
  source: string,
  quote: string,
  near: LineRange,
  normalize: (text: string) => string,
): LineRange | null {
  const needle = normalize(quote);
  if (needle === "") return null;

  let text = "";
  const pieces: { offset: number; line: number }[] = [];
  source.split("\n").forEach((line, index) => {
    const piece = normalize(line);
    if (piece === "") return;
    if (text !== "") text += " ";
    pieces.push({ offset: text.length, line: index + 1 });
    text += piece;
  });
  if (pieces.length === 0) return null;
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

  return nearestMatch(text, needle, near, lineAt);
}

export interface QuotedLines extends LineRange {
  exactText: string;
}

function placeRange(
  source: string,
  input: { lineStart?: number | null; lineEnd?: number | null },
  exactText: string,
  lineContains: (quotedText: string) => boolean,
  locate: (near: LineRange) => LineRange | null,
): QuotedLines | null {
  if (exactText === "") return null;
  if (input.lineStart != null || input.lineEnd != null) {
    const named = computeAnchor(source, "", input.lineStart ?? input.lineEnd!, input.lineEnd ?? input.lineStart!, "");
    if (lineContains(named.quotedText)) return { lineStart: named.lineStart, lineEnd: named.lineEnd, exactText };
    const found = locate(named);
    return found && { ...found, exactText };
  }
  const found = locate({ lineStart: 1, lineEnd: 1 });
  return found && { ...found, exactText };
}

function placeBy(
  source: string,
  input: { lineStart?: number | null; lineEnd?: number | null; exactText: string },
  normalize: (text: string) => string,
): QuotedLines | null {
  const quote = normalize(input.exactText);
  return placeRange(
    source,
    input,
    quote,
    (quoted) => normalize(quoted).includes(quote),
    (near) => locateBy(source, quote, near, normalize),
  );
}

export function placeQuote(source: string, input: LineRange & { exactText: string }): QuotedLines | null {
  return placeBy(source, input, looseText);
}

export function placeWords(
  source: string,
  input: { lineStart?: number | null; lineEnd?: number | null; exactText: string },
): QuotedLines | null {
  return placeBy(source, input, wordsOf);
}

const HTML_ENTITY_AT = /&(#x[0-9a-f]+|#\d+|[a-z]+);/iy;
const HTML_IGNORED_AT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/iy;
const HTML_TAG_AT = /<(?:\/[a-z][a-z0-9:-]*\s*|![a-z][^>]*|[a-z][a-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*)?\/?)>/iy;
const HTML_BLOCK_BREAK = /^<(?:\/(?:p|div|li|td|th|tr|h[1-6]|blockquote|section|article|header|footer|aside|main|nav|pre)|(?:br|hr)\b)/i;

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function htmlAttr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

function extractHtmlVisible(source: string): { text: string; lineOf: number[] } {
  let text = "";
  const lineOf: number[] = [];
  let line = 1;
  let pendingSpace = false;

  const push = (chunk: string, charLine: number): void => {
    for (const ch of chunk) {
      if (/\s/.test(ch)) {
        if (text.length > 0) pendingSpace = true;
      } else {
        if (pendingSpace) {
          text += " ";
          lineOf.push(charLine);
          pendingSpace = false;
        }
        text += ch;
        lineOf.push(charLine);
      }
    }
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\n") {
      if (text.length > 0) pendingSpace = true;
      line++;
      continue;
    }
    if (ch === "<") {
      HTML_IGNORED_AT.lastIndex = i;
      const ignored = HTML_IGNORED_AT.exec(source);
      if (ignored) {
        if (text.length > 0) pendingSpace = true;
        line += countNewlines(ignored[0]);
        i += ignored[0].length - 1;
        continue;
      }
      HTML_TAG_AT.lastIndex = i;
      const tagMatch = HTML_TAG_AT.exec(source);
      if (tagMatch) {
        const tag = tagMatch[0];
        if (/^<img\b/i.test(tag)) push(htmlAttr(tag, "alt").trim() || htmlAttr(tag, "src"), line);
        else if (HTML_BLOCK_BREAK.test(tag) && text.length > 0) pendingSpace = true;
        line += countNewlines(tag);
        i += tag.length - 1;
        continue;
      }
    }
    if (ch === "&") {
      HTML_ENTITY_AT.lastIndex = i;
      const entMatch = HTML_ENTITY_AT.exec(source);
      const decoded = entMatch ? decodeHtmlEntity(entMatch[1]!) : "";
      if (entMatch && decoded) {
        push(decoded, line);
        i += entMatch[0].length - 1;
        continue;
      }
    }
    push(ch, line);
  }
  return { text, lineOf };
}

function nearestMatch(text: string, needle: string, near: LineRange, lineAt: (offset: number) => number): LineRange | null {
  if (needle === "" || text === "") return null;
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

export function locateHtml(source: string, quote: string, near: LineRange): LineRange | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle === "") return null;
  const { text, lineOf } = extractHtmlVisible(source);
  return nearestMatch(text, needle, near, (offset) => lineOf[offset] ?? 1);
}

export function placeHtml(
  source: string,
  input: { lineStart?: number | null; lineEnd?: number | null; exactText: string },
): QuotedLines | null {
  const exactText = input.exactText.replace(/\s+/g, " ").trim();
  return placeRange(
    source,
    input,
    exactText,
    (quoted) => extractHtmlVisible(quoted).text.includes(exactText),
    (near) => locateHtml(source, exactText, near),
  );
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
    if (
      (occ.start !== anchor.lineStart || occ.end !== anchor.lineEnd) &&
      looseText(anchor.quotedText).length < SHORT_SINGLE_QUOTE_MIN &&
      (anchor.prefix.trim().length > 0 || anchor.suffix.trim().length > 0) &&
      !shortContextMatches(lines, occ, anchor)
    ) {
      return { status: "outdated", lineStart: anchor.lineStart, lineEnd: anchor.lineEnd, confidence: 0 };
    }
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

const SHORT_SINGLE_QUOTE_MIN = 24;
const MIN_SHORT_CONTEXT_SIMILARITY = 0.7;
const MIN_TOKEN_LCS_RATIO = 0.8;
const MIN_FUZZY_TOKEN_LEN = 4;
const MIN_FUZZY_SCORE = 1.2;
const MIN_FUZZY_MARGIN = 0.3;

function shortContextMatches(lines: string[], occ: Occurrence, anchor: Anchor): boolean {
  const before = lines.slice(0, occ.start - 1).join("\n");
  const after = lines.slice(occ.end).join("\n");
  const scores: number[] = [];
  if (anchor.prefix.trim().length > 0) scores.push(contextSideSimilarity(anchor.prefix, before, "prefix"));
  if (anchor.suffix.trim().length > 0) scores.push(contextSideSimilarity(anchor.suffix, after, "suffix"));
  return scores.length > 0 && Math.max(...scores) >= MIN_SHORT_CONTEXT_SIMILARITY;
}

function contextSideSimilarity(stored: string, actual: string, side: "prefix" | "suffix"): number {
  if (!actual) return 0;
  const clipped = side === "prefix" ? stored.slice(Math.max(0, stored.length - CONTEXT)) : stored.slice(0, CONTEXT);
  const window = side === "prefix" ? actual.slice(Math.max(0, actual.length - clipped.length)) : actual.slice(0, clipped.length);
  let best = tokenOverlap(contextTokens(clipped), contextTokens(window));
  if (clipped.includes("\n") || clipped.length < CONTEXT) {
    const storedLine = immediateContextLine(clipped, side);
    const actualLine = immediateContextLine(actual, side);
    if (storedLine && actualLine) {
      best = Math.max(best, tokenOverlap(contextTokens(storedLine), contextTokens(actualLine)));
    }
  }
  return best;
}

function immediateContextLine(text: string, side: "prefix" | "suffix"): string {
  const parts = text.split("\n");
  if (side === "prefix") {
    for (let i = parts.length - 1; i >= 0; i--) {
      const trimmed = parts[i]!.trim();
      if (trimmed) return trimmed;
    }
    return "";
  }
  for (let i = 0; i < parts.length; i++) {
    const trimmed = parts[i]!.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function contextTokens(text: string): string[] {
  const normalized = wordsOf(text) || text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized
    .split(" ")
    .map((part) => part.replace(/^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu, "") || part)
    .filter((part) => part.length > 0);
}

function lcsLength(a: string, b: string): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length]!;
}

function tokenMatch(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < MIN_FUZZY_TOKEN_LEN) return 0;
  const ratio = lcsLength(a, b) / Math.max(a.length, b.length);
  return ratio >= MIN_TOKEN_LCS_RATIO ? ratio : 0;
}

function tokenOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      const match = prev[j - 1]! + tokenMatch(a[i - 1]!, b[j - 1]!);
      curr[j] = Math.max(match, prev[j]!, curr[j - 1]!);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length]! / Math.max(a.length, b.length);
}

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

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", bull: "•", copy: "©", reg: "®",
  trade: "™", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", deg: "°",
};

function decodeEntity(name: string): string {
  return decodeHtmlEntity(name);
}

export function decodeHtmlEntity(name: string): string {
  if (name[0] === "#") {
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  return ENTITIES[name.toLowerCase()] ?? "";
}

const TABLE_SEP = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*(?::?-{3,}:?\s*\|?)?\s*$/gm;

export function plainQuote(markdown: string): string {
  return markdown
    .replace(
      /\\.|!\[((?:\\.|[^\]\\])*)\]\((?:\\.|[^)\\])*\)|\[((?:\\.|[^\]\\])*)\]\((?:\\.|[^)\\])*\)|\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g,
      (m, img?: string, link?: string, wiki?: string) => (m[0] === "\\" ? m : img ?? link ?? wiki ?? ""),
    )
    .replace(/\\.|`+|~~|\*\*+|(^|\W)\*+(?=[^\s*])|([^\s\\*])\*+(?=\W|$)/g, (m, open?: string, close?: string) =>
      m[0] === "\\" ? m : open ?? close ?? "",
    )
    .replace(/\\.|(^|\W)_+|_+(?=\W|$)/g, (m, pre?: string) => (m[0] === "\\" ? m : pre ?? ""))
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""))
    .join("\n")
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, esc?: string, ent?: string) =>
      esc !== undefined ? esc : decodeEntity(ent!) || m,
    )
    .trim();
}

export function wordsOf(text: string): string {
  return looseText(plainQuote(text).replace(TABLE_SEP, "").replace(/\|/g, " "));
}
