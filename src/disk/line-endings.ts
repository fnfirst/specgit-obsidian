import type { Splice } from "../editor/splice";

export type Eol = "lf" | "crlf";

export const toLf = (text: string): string => text.replace(/\r\n?/g, "\n");

export function eolOf(text: string): Eol {
  const crlf = text.split("\r\n").length - 1;
  const breaks = text.split("\n").length - 1;
  return crlf * 2 > breaks ? "crlf" : "lf";
}

export const withEol = (lf: string, eol: Eol): string => (eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf);

export class LineEndingMap {

  private readonly breaks: number[] = [];

  constructor(text: string) {
    let from = text.indexOf("\r\n");
    while (from >= 0) {
      this.breaks.push(from - this.breaks.length);
      from = text.indexOf("\r\n", from + 2);
    }
  }

  get crlf(): boolean {
    return this.breaks.length > 0;
  }

  get pairs(): number {
    return this.breaks.length;
  }

  toLf(offset: number): number {
    if (!this.crlf) return offset;

    let low = 0;
    let high = this.breaks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.breaks[mid] ?? 0) + mid < offset) low = mid + 1;
      else high = mid;
    }
    return offset - low;
  }

  toText(offset: number): number {
    if (!this.crlf) return offset;
    let low = 0;
    let high = this.breaks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.breaks[mid] ?? 0) < offset) low = mid + 1;
      else high = mid;
    }
    return offset + low;
  }

  toTextSplice(splice: Splice, eol: Eol): Splice {
    return { from: this.toText(splice.from), to: this.toText(splice.to), insert: withEol(splice.insert, eol) };
  }
}
