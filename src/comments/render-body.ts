import { PLUGIN_COMMENT_WORDS } from "./words";

interface RenderContext {
  refs: ReadonlyMap<string, string>;
  openUrl: (url: string) => void;
  insideLink: boolean;
  depth: number;
}

const MAX_NESTING_DEPTH = 12;
const ASCII_ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const MENTION_PATTERN = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\b/;
const BARE_HTTPS_PATTERN = /^https:\/\/[^\s<>]+/;
const REF_DEF_LINE = /^ {0,3}\[([^\]]+)\]:[ \t]+(?:<([^\n>]+)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_LINE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const THEMATIC_BREAK = /^ {0,3}(?:(\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const BLOCKQUOTE_LINE = /^ {0,3}> ?(.*)$/;
const UL_ITEM = /^ {0,3}([-*+])[ \t]+(.*)$/;
const OL_ITEM = /^ {0,3}(\d{1,9})([.)])[ \t]+(.*)$/;
const UNSAFE_URL_CHARS = /[\s\p{Cc}]/u;

function normalizeRef(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function safeHttpsUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (!unwrapped || UNSAFE_URL_CHARS.test(unwrapped) || !/^https:\/\//i.test(unwrapped)) return null;
  try {
    const parsed = new URL(unwrapped);
    return parsed.protocol === "https:" ? unwrapped : null;
  } catch {
    return null;
  }
}

function isClosingFence(line: string, fenceChar: string, fenceLen: number): boolean {
  const trimmed = line.replace(/^ {0,3}/, "");
  let run = 0;
  while (run < trimmed.length && trimmed[run] === fenceChar) run++;
  if (run < fenceLen) return false;
  return /^[ \t]*$/.test(trimmed.slice(run));
}

function collectReferences(lines: readonly string[]): { refs: Map<string, string>; refLines: Set<number> } {
  const refs = new Map<string, string>();
  const refLines = new Set<number>();
  let fenceChar = "";
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fenceChar !== "") {
      if (isClosingFence(line, fenceChar, fenceLen)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[1]!;
      const info = open[2]!;
      if (marker[0] !== "`" || !info.includes("`")) {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
        continue;
      }
    }
    const def = REF_DEF_LINE.exec(line);
    if (def) {
      const key = normalizeRef(def[1]!);
      const dest = (def[2] ?? def[3] ?? "").trim();
      if (key !== "" && dest !== "" && !refs.has(key)) refs.set(key, dest);
      refLines.add(i);
    }
  }
  return { refs, refLines };
}

function createSafeLink(parent: HTMLElement, href: string, openUrl: (url: string) => void): HTMLAnchorElement {
  const anchor = parent.createEl("a", { attr: { href, rel: "noopener noreferrer" } });
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openUrl(href);
  });
  return anchor;
}

function trimTrailingAutolinkChars(candidate: string): string {
  let end = candidate.length;
  while (end > 8) {
    const ch = candidate[end - 1]!;
    if (".,:;!?'\"".includes(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      let open = 0;
      let close = 0;
      for (let i = 0; i < end; i++) {
        if (candidate[i] === "(") open++;
        else if (candidate[i] === ")") close++;
      }
      if (close > open) {
        end--;
        continue;
      }
    }
    if (ch === "]") {
      let open = 0;
      let close = 0;
      for (let i = 0; i < end; i++) {
        if (candidate[i] === "[") open++;
        else if (candidate[i] === "]") close++;
      }
      if (close > open) {
        end--;
        continue;
      }
    }
    break;
  }
  return candidate.slice(0, end);
}

function canStartBareHttps(text: string, i: number, prev: string): boolean {
  const before = i === 0 ? prev : text[i - 1]!;
  if (before === "" || /^[\s*_~]$/.test(before)) return true;
  if (before === "(") {
    const beforeParen = i === 0 ? "" : i === 1 ? prev : text[i - 2]!;
    return beforeParen === "" || /^[\s(*_~]$/.test(beforeParen);
  }
  return false;
}

function appendPlainSegment(parent: HTMLElement, text: string, ctx: RenderContext, prevChar: string): string {
  if (!text) return prevChar;
  if (ctx.insideLink) {
    parent.append(text);
    return text[text.length - 1]!;
  }
  let buf = "";
  let prev = prevChar;
  const flush = (): void => {
    if (buf !== "") {
      parent.append(buf);
      prev = buf[buf.length - 1]!;
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("https://", i) && canStartBareHttps(text, i, prev)) {
      const raw = BARE_HTTPS_PATTERN.exec(text.slice(i));
      if (raw) {
        const candidate = trimTrailingAutolinkChars(raw[0]);
        const safe = safeHttpsUrl(candidate);
        if (safe !== null) {
          flush();
          const anchor = createSafeLink(parent, safe, ctx.openUrl);
          anchor.append(candidate);
          prev = candidate[candidate.length - 1]!;
          i += candidate.length;
          continue;
        }
      }
    }
    if (text[i] === "@") {
      const before = i === 0 ? prev : text[i - 1]!;
      if (before === "" || !/[\w@`]/.test(before)) {
        const match = MENTION_PATTERN.exec(text.slice(i + 1));
        if (match) {
          const user = match[1]!;
          const url = `https://github.com/${user}`;
          flush();
          const anchor = createSafeLink(parent, url, ctx.openUrl);
          anchor.append(`@${user}`);
          prev = user[user.length - 1]!;
          i += 1 + user.length;
          continue;
        }
      }
    }
    buf += text[i]!;
    i++;
  }
  flush();
  return prev;
}

function findCodeSpanClose(text: string, afterOpen: number, ticks: number): number | null {
  let pos = afterOpen;
  while (pos < text.length) {
    if (text[pos] === "`") {
      let run = 0;
      while (pos + run < text.length && text[pos + run] === "`") run++;
      if (run === ticks) return pos;
      pos += run;
    } else {
      pos++;
    }
  }
  return null;
}

function readBracketed(text: string, openIndex: number): { inner: string; closeIndex: number } | null {
  if (text[openIndex] !== "[") return null;
  let depth = 0;
  let pos = openIndex;
  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === "\\" && pos + 1 < text.length) {
      pos += 2;
      continue;
    }
    if (ch === "`") {
      let ticks = 0;
      while (pos + ticks < text.length && text[pos + ticks] === "`") ticks++;
      const close = findCodeSpanClose(text, pos + ticks, ticks);
      pos = close === null ? pos + ticks : close + ticks;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return { inner: text.slice(openIndex + 1, pos), closeIndex: pos };
    }
    pos++;
  }
  return null;
}

function readParenDestination(text: string, openIndex: number): { url: string; closeIndex: number } | null {
  if (text[openIndex] !== "(") return null;
  let pos = openIndex + 1;
  while (pos < text.length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\n")) pos++;
  if (pos >= text.length) return null;
  let rawUrl = "";
  if (text[pos] === "<") {
    pos++;
    const start = pos;
    while (pos < text.length && text[pos] !== ">" && text[pos] !== "\n") {
      if (text[pos] === "\\" && pos + 1 < text.length) pos += 2;
      else pos++;
    }
    if (pos >= text.length || text[pos] !== ">") return null;
    rawUrl = text.slice(start, pos);
    pos++;
  } else {
    const start = pos;
    let parens = 0;
    while (pos < text.length) {
      const ch = text[pos]!;
      if (ch === "\\" && pos + 1 < text.length) {
        pos += 2;
        continue;
      }
      if (ch === "(") parens++;
      else if (ch === ")") {
        if (parens === 0) break;
        parens--;
      } else if (/\s/.test(ch)) {
        break;
      }
      pos++;
    }
    rawUrl = text.slice(start, pos);
  }
  while (pos < text.length && text[pos] !== ")") {
    if (text[pos] === "\\" && pos + 1 < text.length) pos += 2;
    else if (text[pos] === "(") return null;
    else pos++;
  }
  if (pos >= text.length || text[pos] !== ")") return null;
  return { url: rawUrl, closeIndex: pos };
}

const DELIM_PUNCT = /^[\p{P}\p{S}]$/u;

function isDelimPunct(ch: string): boolean {
  return ch !== "" && DELIM_PUNCT.test(ch);
}

function delimiterFlags(first: string, before: string, after: string): { canOpen: boolean; canClose: boolean } {
  const afterSpace = after === "" || /\s/.test(after);
  const beforeSpace = before === "" || /\s/.test(before);
  const afterPunct = isDelimPunct(after);
  const beforePunct = isDelimPunct(before);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  if (first === "_") {
    return {
      canOpen: leftFlanking && (!rightFlanking || beforePunct),
      canClose: rightFlanking && (!leftFlanking || afterPunct),
    };
  }
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

function readImageEnd(text: string, bangPos: number, refs: ReadonlyMap<string, string>): { alt: string; endIndex: number } | null {
  if (!text.startsWith("![", bangPos)) return null;
  const altBracket = readBracketed(text, bangPos + 1);
  if (!altBracket) return null;
  const afterAlt = altBracket.closeIndex + 1;
  const paren = readParenDestination(text, afterAlt);
  if (paren) return { alt: altBracket.inner, endIndex: paren.closeIndex + 1 };
  const refBracket = readBracketed(text, afterAlt);
  if (refBracket) return { alt: altBracket.inner, endIndex: refBracket.closeIndex + 1 };
  if (refs.has(normalizeRef(altBracket.inner))) return { alt: altBracket.inner, endIndex: afterAlt };
  return null;
}

function readLinkTarget(
  text: string,
  openPos: number,
  refs: ReadonlyMap<string, string>,
): { inner: string; dest: string; endIndex: number } | null {
  if (text[openPos] !== "[" || text.startsWith("[[", openPos)) return null;
  const label = readBracketed(text, openPos);
  if (!label) return null;
  const afterLabel = label.closeIndex + 1;
  const paren = readParenDestination(text, afterLabel);
  if (paren) return { inner: label.inner, dest: paren.url, endIndex: paren.closeIndex + 1 };
  const refBracket = readBracketed(text, afterLabel);
  if (refBracket) {
    const dest = refs.get(normalizeRef(refBracket.inner || label.inner));
    return dest === undefined ? null : { inner: label.inner, dest, endIndex: refBracket.closeIndex + 1 };
  }
  const dest = refs.get(normalizeRef(label.inner));
  return dest === undefined ? null : { inner: label.inner, dest, endIndex: afterLabel };
}

function findDelimiterClose(
  text: string,
  start: number,
  marker: string,
  openerCanClose: boolean,
  refs: ReadonlyMap<string, string>,
): number | null {
  const first = marker[0]!;
  const needLen = marker.length;
  const stack: Array<{ len: number; canBoth: boolean }> = [];
  let pos = start;
  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === "\\" && pos + 1 < text.length) {
      pos += 2;
      continue;
    }
    if (ch === "`") {
      let ticks = 0;
      while (pos + ticks < text.length && text[pos + ticks] === "`") ticks++;
      const close = findCodeSpanClose(text, pos + ticks, ticks);
      pos = close === null ? pos + ticks : close + ticks;
      continue;
    }
    if (text.startsWith("![[", pos)) {
      const end = text.indexOf("]]", pos + 3);
      if (end !== -1 && !text.slice(pos, end).includes("\n")) {
        pos = end + 2;
        continue;
      }
    }
    if (text.startsWith("![", pos)) {
      const img = readImageEnd(text, pos, refs);
      if (img !== null) {
        pos = img.endIndex;
        continue;
      }
    }
    if (ch === "[" && !text.startsWith("[[", pos)) {
      const link = readLinkTarget(text, pos, refs);
      if (link !== null) {
        pos = link.endIndex;
        continue;
      }
    }
    if (ch === "<") {
      const end = text.indexOf(">", pos + 1);
      if (end !== -1 && !text.slice(pos + 1, end).includes("<") && !/\s/.test(text.slice(pos + 1, end)) && safeHttpsUrl(text.slice(pos + 1, end)) !== null) {
        pos = end + 1;
        continue;
      }
    }
    if (ch === first) {
      let run = 0;
      while (pos + run < text.length && text[pos + run] === first) run++;
      if (first === "~" && run < 2) {
        pos += run;
        continue;
      }
      const before = pos > 0 ? text[pos - 1]! : "";
      const after = pos + run < text.length ? text[pos + run]! : "";
      const { canOpen, canClose } = delimiterFlags(first, before, after);
      let rem = run;
      let consumed = 0;
      if (canClose && pos > start) {
        const closerCanBoth = canOpen && canClose;
        while (rem > 0 && stack.length > 0) {
          const top = stack[stack.length - 1]!;
          if ((top.canBoth || closerCanBoth) && (top.len + rem) % 3 === 0 && (top.len % 3 !== 0 || rem % 3 !== 0)) {
            break;
          }
          if (rem >= top.len) {
            consumed += top.len;
            rem -= top.len;
            stack.pop();
          } else {
            top.len -= rem;
            consumed += rem;
            rem = 0;
          }
        }
        if (stack.length === 0 && rem >= needLen) {
          const rule9Blocked = (openerCanClose || closerCanBoth) && (needLen + rem) % 3 === 0 && (needLen % 3 !== 0 || rem % 3 !== 0);
          if (!rule9Blocked) return pos + consumed;
        }
      }
      if (canOpen && rem > 0) {
        stack.push({ len: rem, canBoth: canOpen && canClose });
      }
      pos += run;
      continue;
    }
    pos++;
  }
  return null;
}

function unescapeText(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function renderInline(parent: HTMLElement, text: string, ctx: RenderContext, initialPrev = ""): string {
  let plain = "";
  let prev = initialPrev;
  const flushPlain = (): void => {
    if (plain !== "") {
      prev = appendPlainSegment(parent, plain, ctx, prev);
      plain = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === "\n") {
      if (plain.endsWith("  ")) {
        plain = plain.slice(0, -2);
        flushPlain();
        parent.createEl("br");
        prev = "\n";
      } else if (plain.endsWith("\\")) {
        plain = plain.slice(0, -1);
        flushPlain();
        parent.createEl("br");
        prev = "\n";
      } else {
        plain += "\n";
      }
      i++;
      continue;
    }

    if (text[i] === "\\" && i + 1 < text.length && ASCII_ESCAPABLE.test(text.slice(i + 1))) {
      plain += text[i + 1]!;
      i += 2;
      continue;
    }

    if (text[i] === "`") {
      let ticks = 0;
      while (i + ticks < text.length && text[i + ticks] === "`") ticks++;
      const close = findCodeSpanClose(text, i + ticks, ticks);
      if (close !== null) {
        flushPlain();
        let code = text.slice(i + ticks, close).replace(/\n/g, " ");
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code)) {
          code = code.slice(1, -1);
        }
        parent.createEl("code", { text: code });
        prev = "`";
        i = close + ticks;
        continue;
      }
      plain += "`".repeat(ticks);
      i += ticks;
      continue;
    }

    if (text.startsWith("![[", i)) {
      const end = text.indexOf("]]", i + 3);
      if (end !== -1 && !text.slice(i, end).includes("\n")) {
        plain += text.slice(i, end + 2);
        i = end + 2;
        continue;
      }
    }

    if (text.startsWith("![", i)) {
      const img = readImageEnd(text, i, ctx.refs);
      if (img) {
        flushPlain();
        if (img.alt !== "") plain += `[${unescapeText(img.alt)}]`;
        i = img.endIndex;
        continue;
      }
    }

    if (text[i] === "[" && !text.startsWith("[[", i)) {
      const link = readLinkTarget(text, i, ctx.refs);
      if (link) {
        flushPlain();
        const safe = safeHttpsUrl(unescapeText(link.dest));
        if (safe !== null && !ctx.insideLink && ctx.depth < MAX_NESTING_DEPTH) {
          const anchor = createSafeLink(parent, safe, ctx.openUrl);
          prev = renderInline(anchor, link.inner, { ...ctx, insideLink: true, depth: ctx.depth + 1 }, "");
        } else if (ctx.depth < MAX_NESTING_DEPTH) {
          prev = renderInline(parent, link.inner, { ...ctx, depth: ctx.depth + 1 }, prev);
        } else {
          plain += unescapeText(link.inner);
        }
        i = link.endIndex;
        continue;
      }
    }

    if (text[i] === "<") {
      const end = text.indexOf(">", i + 1);
      if (end !== -1 && !text.slice(i + 1, end).includes("<") && !/\s/.test(text.slice(i + 1, end))) {
        const candidate = text.slice(i + 1, end);
        const safe = safeHttpsUrl(candidate);
        if (safe !== null && !ctx.insideLink) {
          flushPlain();
          const anchor = createSafeLink(parent, safe, ctx.openUrl);
          anchor.append(safe);
          prev = safe[safe.length - 1]!;
          i = end + 1;
          continue;
        }
      }
    }

    if (ctx.depth < MAX_NESTING_DEPTH) {
      let matchedDelim = false;
      for (const marker of ["***", "___", "**", "__", "~~", "*", "_"] as const) {
        if (!text.startsWith(marker, i)) continue;
        const first = marker[0]!;
        if (first === "~" && text.startsWith("~~~", i)) continue;
        const afterOpen = i + marker.length;
        if (afterOpen >= text.length) continue;
        let tail = i;
        while (tail < text.length && text[tail] === first) tail++;
        const openFlags = delimiterFlags(first, i > 0 ? text[i - 1]! : "", tail < text.length ? text[tail]! : "");
        if (!openFlags.canOpen) continue;
        const close = findDelimiterClose(text, afterOpen, marker, openFlags.canClose, ctx.refs);
        if (close === null) continue;
        flushPlain();
        const inner = text.slice(afterOpen, close);
        const nextCtx: RenderContext = { ...ctx, depth: ctx.depth + 1 };
        if (marker === "***" || marker === "___") {
          const strong = parent.createEl("strong");
          const em = strong.createEl("em");
          prev = renderInline(em, inner, nextCtx, "");
        } else {
          const tag = marker === "**" || marker === "__" ? "strong" : marker === "~~" ? "del" : "em";
          const el = parent.createEl(tag);
          prev = renderInline(el, inner, nextCtx, "");
        }
        i = close + marker.length;
        matchedDelim = true;
        break;
      }
      if (matchedDelim) continue;
    }

    plain += text[i]!;
    i++;
  }

  flushPlain();
  return prev;
}

function isBlockStart(lines: readonly string[], index: number, refLines: ReadonlySet<number>): boolean {
  if (refLines.has(index)) return true;
  const line = lines[index]!;
  if (/^[ \t]*$/.test(line)) return true;
  const fence = FENCE_OPEN.exec(line);
  if (fence && (fence[1]![0] !== "`" || !fence[2]!.includes("`"))) return true;
  return HEADING_LINE.test(line) || THEMATIC_BREAK.test(line) || BLOCKQUOTE_LINE.test(line) || UL_ITEM.test(line) || OL_ITEM.test(line);
}

function renderList(
  parent: HTMLElement,
  lines: readonly string[],
  start: number,
  ordered: boolean,
  ctx: RenderContext,
  refLines: ReadonlySet<number>,
): number {
  const firstMatch = (ordered ? OL_ITEM : UL_ITEM).exec(lines[start]!)!;
  const startNum = ordered ? Number(firstMatch[1]!) : 1;
  const list = parent.createEl(ordered ? "ol" : "ul", ordered && startNum !== 1 ? { attr: { start: String(startNum) } } : undefined);
  let i = start;
  while (i < lines.length) {
    if (refLines.has(i)) break;
    const itemMatch = (ordered ? OL_ITEM : UL_ITEM).exec(lines[i]!);
    if (!itemMatch) break;
    const itemLines = [ordered ? itemMatch[3]! : itemMatch[2]!];
    i++;
    while (i < lines.length && !refLines.has(i)) {
      const next = lines[i]!;
      if (/^[ \t]*$/.test(next)) break;
      if (isBlockStart(lines, i, refLines)) break;
      itemLines.push(next.trimStart());
      i++;
    }
    const li = list.createEl("li");
    renderInline(li, itemLines.join("\n"), ctx);
    while (i < lines.length && /^[ \t]*$/.test(lines[i]!)) {
      let look = i + 1;
      while (look < lines.length && /^[ \t]*$/.test(lines[look]!)) look++;
      if (look < lines.length && (ordered ? OL_ITEM : UL_ITEM).test(lines[look]!)) {
        i = look;
        break;
      }
      return i;
    }
  }
  return i;
}

function renderBlocks(parent: HTMLElement, lines: readonly string[], ctx: RenderContext, refLines: ReadonlySet<number>): void {
  let i = 0;
  while (i < lines.length) {
    if (refLines.has(i) || /^[ \t]*$/.test(lines[i]!)) {
      i++;
      continue;
    }

    const line = lines[i]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence && (fence[1]![0] !== "`" || !fence[2]!.includes("`"))) {
      const fenceChar = fence[1]![0]!;
      const fenceLen = fence[1]!.length;
      const lang = fence[2]!.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !isClosingFence(lines[i]!, fenceChar, fenceLen)) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      const codeText = body.join("\n");
      if (lang === "suggestion") {
        parent.createEl("p", { cls: "specgit-suggestion-label", text: PLUGIN_COMMENT_WORDS.after });
        const pre = parent.createEl("pre", { cls: "specgit-suggestion" });
        pre.createEl("code", { cls: "language-suggestion", text: codeText });
      } else {
        const pre = parent.createEl("pre");
        pre.createEl("code", lang ? { cls: `language-${lang}`, text: codeText } : { text: codeText });
      }
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      const tag = (`h${level}` as const);
      const h = parent.createEl(tag);
      renderInline(h, text, ctx);
      i++;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      parent.createEl("hr");
      i++;
      continue;
    }

    if (BLOCKQUOTE_LINE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && !refLines.has(i)) {
        const match = BLOCKQUOTE_LINE.exec(lines[i]!);
        if (!match) break;
        quoted.push(match[1]!);
        i++;
      }
      if (ctx.depth < MAX_NESTING_DEPTH) {
        const bq = parent.createEl("blockquote");
        renderBlocks(bq, quoted, { ...ctx, depth: ctx.depth + 1 }, new Set());
      } else {
        const p = parent.createEl("p");
        p.append(quoted.join("\n"));
      }
      continue;
    }

    if (UL_ITEM.test(line)) {
      i = renderList(parent, lines, i, false, ctx, refLines);
      continue;
    }

    if (OL_ITEM.test(line)) {
      i = renderList(parent, lines, i, true, ctx, refLines);
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines, i, refLines)) {
      paraLines.push(lines[i]!);
      i++;
    }
    const p = parent.createEl("p");
    renderInline(p, paraLines.join("\n"), ctx);
  }
}

export function renderCommentBody(element: HTMLElement, markdown: string, openUrl: (url: string) => void): () => void {
  element.replaceChildren();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const { refs, refLines } = collectReferences(lines);
  renderBlocks(element, lines, { refs, openUrl, insideLink: false, depth: 0 }, refLines);
  return () => element.replaceChildren();
}
