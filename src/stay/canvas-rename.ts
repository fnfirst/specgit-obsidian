import { gitBlobShaOfText } from "../changes/blob-sha";
import type { GuardedVault } from "../disk/guarded-vault";
import { hasBom, stripBom, withBomAndEol } from "../disk/line-endings";
import { isHiddenPath } from "../mapping";
import type { Activity } from "./activity";
import type { StayState } from "./state";

interface Span {
  start: number;
  end: number;
}

const isWs = (ch: number): boolean => ch === 32 || ch === 9 || ch === 10 || ch === 13;

function skipWs(text: string, at: number): number {
  let i = at;
  while (i < text.length && isWs(text.charCodeAt(i))) i++;
  return i;
}

function scanJsonString(text: string, at: number): { value: string; end: number } | null {
  if (text.charCodeAt(at) !== 34) return null;
  let i = at + 1;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 92) {
      i += 2;
      continue;
    }
    if (ch === 34) {
      try {
        return { value: JSON.parse(text.slice(at, i + 1)) as string, end: i + 1 };
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
}

function skipJsonValue(text: string, at: number): number {
  const i = skipWs(text, at);
  if (i >= text.length) return -1;
  const ch = text.charCodeAt(i);
  if (ch === 34) return scanJsonString(text, i)?.end ?? -1;
  if (ch === 123) {
    let cur = skipWs(text, i + 1);
    if (cur < text.length && text.charCodeAt(cur) === 125) return cur + 1;
    while (cur < text.length) {
      const key = scanJsonString(text, cur);
      if (!key) return -1;
      cur = skipWs(text, key.end);
      if (text.charCodeAt(cur) !== 58) return -1;
      const next = skipJsonValue(text, cur + 1);
      if (next < 0) return -1;
      cur = skipWs(text, next);
      if (text.charCodeAt(cur) === 125) return cur + 1;
      if (text.charCodeAt(cur) !== 44) return -1;
      cur = skipWs(text, cur + 1);
    }
    return -1;
  }
  if (ch === 91) {
    let cur = skipWs(text, i + 1);
    if (cur < text.length && text.charCodeAt(cur) === 93) return cur + 1;
    while (cur < text.length) {
      const next = skipJsonValue(text, cur);
      if (next < 0) return -1;
      cur = skipWs(text, next);
      if (text.charCodeAt(cur) === 93) return cur + 1;
      if (text.charCodeAt(cur) !== 44) return -1;
      cur = skipWs(text, cur + 1);
    }
    return -1;
  }
  let end = i;
  while (end < text.length) {
    const c = text.charCodeAt(end);
    if (isWs(c) || c === 44 || c === 93 || c === 125) break;
    end++;
  }
  return end > i ? end : -1;
}

function findNodeFileSpans(body: string, from: string): Span[] | null {
  let cur = skipWs(body, 0);
  if (body.charCodeAt(cur) !== 123) return null;
  cur = skipWs(body, cur + 1);
  if (cur < body.length && body.charCodeAt(cur) === 125) return [];
  const spans: Span[] = [];
  while (cur < body.length) {
    const key = scanJsonString(body, cur);
    if (!key) return null;
    cur = skipWs(body, key.end);
    if (body.charCodeAt(cur) !== 58) return null;
    const valStart = skipWs(body, cur + 1);
    if (key.value === "nodes") spans.length = 0;
    if (key.value === "nodes" && body.charCodeAt(valStart) === 91) {
      let arrCur = skipWs(body, valStart + 1);
      if (arrCur < body.length && body.charCodeAt(arrCur) === 93) {
        cur = arrCur + 1;
      } else {
        while (arrCur < body.length) {
          if (body.charCodeAt(arrCur) === 123) {
            let objCur = skipWs(body, arrCur + 1);
            let nodeType: string | null = null;
            let fileSpan: (Span & { value: string }) | null = null;
            if (objCur < body.length && body.charCodeAt(objCur) === 125) {
              arrCur = objCur + 1;
            } else {
              while (objCur < body.length) {
                const nKey = scanJsonString(body, objCur);
                if (!nKey) return null;
                objCur = skipWs(body, nKey.end);
                if (body.charCodeAt(objCur) !== 58) return null;
                const nValStart = skipWs(body, objCur + 1);
                if ((nKey.value === "type" || nKey.value === "file") && body.charCodeAt(nValStart) === 34) {
                  const str = scanJsonString(body, nValStart);
                  if (!str) return null;
                  if (nKey.value === "type") nodeType = str.value;
                  else fileSpan = { start: nValStart, end: str.end, value: str.value };
                  objCur = str.end;
                } else {
                  if (nKey.value === "type") nodeType = null;
                  else if (nKey.value === "file") fileSpan = null;
                  const next = skipJsonValue(body, nValStart);
                  if (next < 0) return null;
                  objCur = next;
                }
                objCur = skipWs(body, objCur);
                if (body.charCodeAt(objCur) === 125) {
                  arrCur = objCur + 1;
                  break;
                }
                if (body.charCodeAt(objCur) !== 44) return null;
                objCur = skipWs(body, objCur + 1);
              }
            }
            if (nodeType === "file" && fileSpan !== null && fileSpan.value === from) {
              spans.push({ start: fileSpan.start, end: fileSpan.end });
            }
          } else {
            const next = skipJsonValue(body, arrCur);
            if (next < 0) return null;
            arrCur = next;
          }
          arrCur = skipWs(body, arrCur);
          if (body.charCodeAt(arrCur) === 93) {
            cur = arrCur + 1;
            break;
          }
          if (body.charCodeAt(arrCur) !== 44) return null;
          arrCur = skipWs(body, arrCur + 1);
        }
      }
    } else {
      const next = skipJsonValue(body, valStart);
      if (next < 0) return null;
      cur = next;
    }
    cur = skipWs(body, cur);
    if (body.charCodeAt(cur) === 125) return spans;
    if (body.charCodeAt(cur) !== 44) return null;
    cur = skipWs(body, cur + 1);
  }
  return null;
}

export function rewriteCanvasFileRefsText(raw: string, from: string, to: string): string | null {
  if (from === to || from === "" || to === "") return null;
  const escapedFrom = JSON.stringify(from).slice(1, -1);
  if (!raw.includes(from) && !raw.includes(escapedFrom) && !raw.includes("\\u") && !(from.includes("/") && raw.includes("\\/"))) return null;
  const body = stripBom(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  let changed = false;
  for (const node of nodes) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    if (record.type === "file" && record.file === from) {
      record.file = to;
      changed = true;
    }
  }
  if (!changed) return null;
  const expectedJson = JSON.stringify(parsed);
  const spans = findNodeFileSpans(body, from);
  if (spans !== null && spans.length > 0) {
    const replacement = JSON.stringify(to);
    let spliced = body;
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i]!;
      spliced = `${spliced.slice(0, span.start)}${replacement}${spliced.slice(span.end)}`;
    }
    try {
      if (JSON.stringify(JSON.parse(spliced)) === expectedJson) {
        return hasBom(raw) ? `\uFEFF${spliced}` : spliced;
      }
    } catch {
      void 0;
    }
  }
  const indent = /\n(\t+| +)"/.exec(body)?.[1] ?? (/\r?\n/.test(body.trimEnd()) ? 2 : undefined);
  const trailingNewline = /\r?\n$/.test(body) ? "\n" : "";
  return withBomAndEol(`${JSON.stringify(parsed, null, indent)}${trailingNewline}`, raw);
}

export async function rewriteCanvasFileRefsOnRename(
  vault: GuardedVault,
  activity: Activity,
  state: StayState,
  now: number,
  from: string,
  to: string,
): Promise<number> {
  if (from === to) return 0;
  const entries = vault.loadedEntries?.() ?? [];
  let updated = 0;
  for (const entry of entries) {
    if (entry.folder || !/\.canvas$/i.test(entry.path) || isHiddenPath(entry.path)) continue;
    const before = await vault.read(entry.path);
    if (before === null || rewriteCanvasFileRefsText(before, from, to) === null) continue;
    let writtenText: string | null = null;
    activity.ownWrite(entry.path);
    const outcome = await vault.process(entry.path, (current) => {
      const next = rewriteCanvasFileRefsText(current, from, to);
      writtenText = next;
      return next;
    });
    if (outcome !== "written" || writtenText === null) {
      activity.notWritten(entry.path);
      continue;
    }
    (state.data.typed ??= {})[entry.path] = { sha: gitBlobShaOfText(writtenText), at: now };
    updated++;
  }
  return updated;
}
