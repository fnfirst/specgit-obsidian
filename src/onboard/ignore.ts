type Token =
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "lit"; char: string }
  | { kind: "class"; negated: boolean; chars: Set<string>; ranges: Array<[number, number]> };

type CompiledSegment = { kind: "globstar" } | { kind: "glob"; tokens: Token[] };

interface Rule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  segments: CompiledSegment[];
}

function trailingBackslashes(text: string, before: number): number {
  let count = 0;
  for (let i = before - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count;
}

function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && trailingBackslashes(line, end - 1) % 2 === 0) end--;
  return line.slice(0, end);
}

function splitUnescapedSlash(pattern: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === "/") {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(pattern.slice(start));
  return parts;
}

function hasUnescapedSlash(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === "/") return true;
  }
  return false;
}

function parseClass(pattern: string, open: number): { token: Token; next: number } | null {
  let i = open + 1;
  if (i >= pattern.length) return null;
  let negated = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negated = true;
    i++;
  }
  const chars = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let first = true;
  while (i < pattern.length) {
    if (pattern[i] === "]" && !first) return { token: { kind: "class", negated, chars, ranges }, next: i + 1 };
    first = false;
    let ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      i++;
      ch = pattern[i]!;
    }
    i++;
    if (i + 1 < pattern.length && pattern[i] === "-" && pattern[i + 1] !== "]") {
      i++;
      let end = pattern[i]!;
      if (end === "\\" && i + 1 < pattern.length) {
        i++;
        end = pattern[i]!;
      }
      i++;
      const lo = ch.charCodeAt(0);
      const hi = end.charCodeAt(0);
      if (lo <= hi) ranges.push([lo, hi]);
    } else {
      chars.add(ch);
    }
  }
  return null;
}

function compileSegment(segment: string): CompiledSegment {
  if (segment === "**") return { kind: "globstar" };
  const tokens: Token[] = [];
  for (let i = 0; i < segment.length; ) {
    const ch = segment[i]!;
    if (ch === "*") {
      if (tokens[tokens.length - 1]?.kind !== "star") tokens.push({ kind: "star" });
      i++;
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
      i++;
    } else if (ch === "[") {
      const parsed = parseClass(segment, i);
      if (parsed) {
        tokens.push(parsed.token);
        i = parsed.next;
      } else {
        tokens.push({ kind: "lit", char: "[" });
        i++;
      }
    } else if (ch === "\\" && i + 1 < segment.length) {
      tokens.push({ kind: "lit", char: segment[i + 1]! });
      i += 2;
    } else {
      tokens.push({ kind: "lit", char: ch });
      i++;
    }
  }
  return { kind: "glob", tokens };
}

function matchToken(token: Token, ch: string): boolean {
  if (token.kind === "any") return true;
  if (token.kind === "lit") return token.char === ch;
  if (token.kind === "class") {
    const code = ch.charCodeAt(0);
    const hit = token.chars.has(ch) || token.ranges.some(([lo, hi]) => code >= lo && code <= hi);
    return token.negated ? !hit : hit;
  }
  return false;
}

function matchGlob(tokens: readonly Token[], text: string): boolean {
  let ti = 0;
  let si = 0;
  let starTi = -1;
  let starSi = -1;
  while (si < text.length) {
    const tok = tokens[ti];
    if (tok !== undefined && tok.kind === "star") {
      starTi = ti++;
      starSi = si;
    } else if (tok !== undefined && matchToken(tok, text[si]!)) {
      ti++;
      si++;
    } else if (starTi !== -1) {
      ti = starTi + 1;
      si = ++starSi;
    } else {
      return false;
    }
  }
  while (ti < tokens.length && tokens[ti]!.kind === "star") ti++;
  return ti === tokens.length;
}

function parseRule(raw: string): Rule | null {
  const line = trimTrailingSpaces(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
  if (line === "" || line.startsWith("#")) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
    if (pattern === "") return null;
  }
  let dirOnly = false;
  if (pattern.endsWith("/") && trailingBackslashes(pattern, pattern.length - 1) % 2 === 0) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
    if (pattern === "") return null;
  }
  const anchored = hasUnescapedSlash(pattern);
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
    if (pattern === "") return null;
  }
  const parts = splitUnescapedSlash(pattern).filter((part) => part !== "");
  if (parts.length === 0) return null;
  return { negated, dirOnly, anchored, segments: parts.map(compileSegment) };
}

function matchRule(rule: Rule, pathSegments: readonly string[], isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (!rule.anchored) {
    const only = rule.segments[0]!;
    if (only.kind === "globstar") return true;
    return matchGlob(only.tokens, pathSegments[pathSegments.length - 1]!);
  }
  const pLen = rule.segments.length;
  const sLen = pathSegments.length;
  let dp = new Array<boolean>(sLen + 1).fill(false);
  dp[0] = true;
  for (let i = 0; i < pLen; i++) {
    const seg = rule.segments[i]!;
    const next = new Array<boolean>(sLen + 1).fill(false);
    if (seg.kind === "globstar") {
      const trailing = i === pLen - 1;
      let seen = false;
      for (let j = 0; j <= sLen; j++) {
        if (trailing) {
          next[j] = seen;
          if (dp[j]) seen = true;
        } else {
          if (dp[j]) seen = true;
          next[j] = seen;
        }
      }
    } else {
      for (let j = 0; j < sLen; j++) {
        if (dp[j] && matchGlob(seg.tokens, pathSegments[j]!)) next[j + 1] = true;
      }
    }
    dp = next;
  }
  return dp[sLen] === true;
}

function normalizePath(path: string): string[] {
  const cleaned = path.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
  return cleaned === "" ? [] : cleaned.split("/").filter((part) => part !== "");
}

export function ignoredBy(text: string): (path: string) => boolean {
  const rules = text.split("\n").map(parseRule).filter((rule): rule is Rule => rule !== null);
  if (rules.length === 0) return () => false;
  const excludedAt = (segments: readonly string[], isDir: boolean): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (matchRule(rule, segments, isDir)) ignored = !rule.negated;
    }
    return ignored;
  };
  return (path: string): boolean => {
    const segments = normalizePath(path);
    if (segments.length === 0) return false;
    for (let depth = 1; depth < segments.length; depth++) {
      if (excludedAt(segments.slice(0, depth), true)) return true;
    }
    return excludedAt(segments, false);
  };
}

export interface IgnoreAdapter {
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  read(path: string): Promise<string>;
}

const NONE = (): boolean => false;

export class VaultIgnore {
  private stamp: { mtime: number; size: number } | null = null;
  private match: (path: string) => boolean = NONE;

  constructor(private readonly adapter: IgnoreAdapter | null) {}

  async refresh(): Promise<void> {
    if (!this.adapter) return;
    try {
      const stat = await this.adapter.stat(".gitignore");
      if (stat === null) {
        this.stamp = null;
        this.match = NONE;
        return;
      }
      if (this.stamp && this.stamp.mtime === stat.mtime && this.stamp.size === stat.size) return;
      const text = await this.adapter.read(".gitignore");
      this.stamp = { mtime: stat.mtime, size: stat.size };
      this.match = ignoredBy(text);
    } catch {
      void 0;
    }
  }

  isIgnored(path: string): boolean {
    return this.match(path);
  }
}
