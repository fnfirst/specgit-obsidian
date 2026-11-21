import { find } from "./alignment";

export type PartKind = "cell" | "title" | "body";

export interface Part {
  kind: PartKind;
  row: number;
  col: number;
  from: number;
  to: number;
  text: string;
}

export interface BlockModel {
  kind: "table" | "callout";
  from: number;
  to: number;
  parts: Part[];
}

interface Line {
  from: number;
  to: number;
}

function linesOf(markdown: string): Line[] {
  const lines: Line[] = [];
  for (let at = 0; at <= markdown.length; ) {
    let end = markdown.indexOf("\n", at);
    if (end < 0) end = markdown.length;
    lines.push({ from: at, to: end > at && markdown.charCodeAt(end - 1) === 13 ? end - 1 : end });
    at = end + 1;
  }
  return lines;
}

const blank = (text: string): string => " ".repeat(text.length);

export function withoutSyntax(text: string): string {
  return text
    .replace(/\\\|/g, " |")
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>\n]*)?\/?>/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank)
    .replace(/\[\[[^\]|\n]*\|/g, blank)
    .replace(/\[\[|\]\]/g, blank);
}

const isSpace = (unit: number): boolean => unit <= 32 || unit === 0xa0 || unit === 0x200b;

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const CALLOUT_HEAD = /^\s{0,3}>\s*\[![^\]\n]+\][+-]?/;

function pipesOf(line: string): number[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === "|" && line[i - 1] !== "\\") pipes.push(i);
  return pipes;
}

function tableModel(markdown: string, lines: Line[], at: number): BlockModel | null {
  const text = (line: Line): string => markdown.slice(line.from, line.to);
  let [first, last] = [at, at];
  while (first > 0 && text(lines[first - 1]!).includes("|")) first--;
  while (last + 1 < lines.length && text(lines[last + 1]!).includes("|")) last++;
  if (!text(lines[at]!).includes("|")) return null;
  let head = -1;
  for (let i = first + 1; i <= last; i++) {
    if (DELIMITER.test(text(lines[i]!))) {
      head = i - 1;
      break;
    }
  }
  if (head < first || at < head) return null;
  const parts: Part[] = [];
  let row = 0;
  for (let i = head; i <= last; i++) {
    if (i === head + 1) continue;
    const line = lines[i]!;
    const source = text(line);
    const working = withoutSyntax(source);
    const pipes = pipesOf(source);
    let start = 0;
    while (start < source.length && isSpace(source.charCodeAt(start))) start++;
    if (pipes[0] === start) {
      start++;
      pipes.shift();
    }
    let col = 0;
    for (const pipe of pipes) {
      parts.push({ kind: "cell", row, col: col++, from: line.from + start, to: line.from + pipe, text: working.slice(start, pipe) });
      start = pipe + 1;
    }
    if (/\S/.test(source.slice(start))) parts.push({ kind: "cell", row, col, from: line.from + start, to: line.to, text: working.slice(start) });
    row++;
  }
  return { kind: "table", from: lines[head]!.from, to: lines[last]!.to, parts };
}

function calloutModel(markdown: string, lines: Line[], at: number): BlockModel | null {
  const quoted = (line: Line): boolean => /^\s{0,3}>/.test(markdown.slice(line.from, line.to));
  if (!quoted(lines[at]!)) return null;
  let [first, last] = [at, at];
  while (first > 0 && quoted(lines[first - 1]!)) first--;
  while (last + 1 < lines.length && quoted(lines[last + 1]!)) last++;
  const head = lines[first]!;
  const headSource = markdown.slice(head.from, head.to);
  const prefix = CALLOUT_HEAD.exec(headSource);
  if (!prefix) return null;
  const parts: Part[] = [{ kind: "title", row: 0, col: 0, from: head.from, to: head.to, text: blank(prefix[0]) + withoutSyntax(headSource.slice(prefix[0].length)) }];
  if (last > first) {
    const body = lines.slice(first + 1, last + 1).map((line) => {
      const source = markdown.slice(line.from, line.to);
      const quote = /^\s{0,3}>[ ]?/.exec(source)?.[0] ?? "";
      return blank(quote) + withoutSyntax(source.slice(quote.length));
    });
    parts.push({ kind: "body", row: 0, col: 0, from: lines[first + 1]!.from, to: lines[last]!.to, text: body.join("\n") });
  }
  return { kind: "callout", from: head.from, to: lines[last]!.to, parts };
}

export function blockModelAt(markdown: string, offset: number): BlockModel | null {
  if (offset < 0 || offset > markdown.length) return null;
  const lines = linesOf(markdown);
  const at = lines.findIndex((line) => offset <= line.to);
  if (at < 0) return null;
  const model = tableModel(markdown, lines, at) ?? calloutModel(markdown, lines, at);
  return model && offset >= model.from && offset <= model.to ? model : null;
}

export function partAt(model: BlockModel, offset: number): Part | null {
  return model.parts.find((part) => part.from <= offset && offset <= part.to) ?? null;
}

export function partsIn(model: BlockModel, from: number, to: number): Part[] {
  return model.parts.filter((part) => Math.min(to, part.to) > Math.max(from, part.from) && /\S/.test(part.text));
}

interface Hit {
  at: number;
  index: number;
}

function hitsOf(part: Part, rendered: string): Hit[] | null {
  const hits: Hit[] = [];
  let at = 0;
  for (let index = 0; index < rendered.length; index++) {
    const unit = rendered.charCodeAt(index);
    if (isSpace(unit)) continue;
    at = find(part.text, unit, at, part.text.length);
    if (at < 0) return null;
    hits.push({ at, index });
    at++;
  }
  return hits.length > 0 ? hits : null;
}

function indexAt(hits: Hit[], rel: number): number {
  const k = hits.findIndex((hit) => hit.at >= rel);
  if (k < 0) return hits[hits.length - 1]!.index + 1;
  if (k > 0 && rel === hits[k - 1]!.at + 1) return hits[k - 1]!.index + 1;
  return hits[k]!.index;
}

export function renderedIndex(part: Part, rendered: string, offset: number): number | null {
  const hits = hitsOf(part, rendered);
  return hits && offset >= part.from && offset <= part.to ? indexAt(hits, offset - part.from) : null;
}

export function renderedSpan(part: Part, rendered: string, from: number, to: number): { start: number; end: number } | null {
  const hits = hitsOf(part, rendered);
  if (!hits) return null;
  const [start, end] = [Math.max(from, part.from), Math.min(to, part.to)];
  if (end <= start) return null;
  const span = { start: indexAt(hits, start - part.from), end: indexAt(hits, end - part.from) };
  return span.end > span.start ? span : null;
}

export function placeable(part: Part, rendered: string): boolean {
  return !/\S/.test(rendered) || hitsOf(part, rendered) !== null;
}
