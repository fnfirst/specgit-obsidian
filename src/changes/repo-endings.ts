import { toLf, withEol } from "../disk/line-endings";

export function uniformEol(text: string): "lf" | "crlf" | null {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const lone = (text.match(/\r(?!\n)/g) ?? []).length;
  if (lone > 0 || (crlf > 0 && lf > 0)) return null;
  return crlf > 0 ? "crlf" : lf > 0 ? "lf" : null;
}

export function inRepoEndings(text: string, repoText: string): string {
  const mine = uniformEol(text);
  const theirs = uniformEol(repoText);
  return mine === null || theirs === null || mine === theirs ? text : withEol(toLf(text), theirs);
}
