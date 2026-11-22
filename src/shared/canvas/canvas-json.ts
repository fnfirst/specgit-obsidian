export interface JsonEntry {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: JsonNode;
}

interface JsonNodeBase {
  start: number;
  end: number;
}

export type JsonNode =
  | (JsonNodeBase & { kind: "object"; value: Record<string, unknown>; entries: JsonEntry[] })
  | (JsonNodeBase & { kind: "array"; value: unknown[]; items: JsonNode[] })
  | (JsonNodeBase & { kind: "scalar"; value: string | number | boolean | null });

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function isJsonSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

export function isJsonWhitespace(src: string): boolean {
  for (let i = 0; i < src.length; i++) if (!isJsonSpace(src.charCodeAt(i))) return false;
  return true;
}

export function parseJsonSpans(src: string): JsonNode {
  const n = src.length;
  let i = 0;

  const describe = (at: number): string =>
    at >= n ? "end of input" : `character ${JSON.stringify(src.charAt(at))}`;
  const fail = (message: string, at: number = i): never => {
    throw new JsonSyntaxError(message, at);
  };
  const unexpected = (): never => fail(`Unexpected ${describe(i)}`);
  const skipSpace = (): void => {
    while (i < n && isJsonSpace(src.charCodeAt(i))) i++;
  };

  const readString = (): string => {
    const open = i;
    i++;
    let out = "";
    let chunk = i;
    for (;;) {
      if (i >= n) fail("Unterminated string", open);
      const c = src.charCodeAt(i);
      if (c === 0x22) {
        out += src.slice(chunk, i);
        i++;
        return out;
      }
      if (c === 0x5c) {
        out += src.slice(chunk, i);
        const e = src.charAt(i + 1);
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\u escape in string", i);
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("Invalid escape in string", i);
        }
        i += 2;
        chunk = i;
        continue;
      }
      if (c < 0x20) fail("Unescaped control character in string");
      i++;
    }
  };

  const readNumber = (): number => {
    const start = i;
    if (src.charCodeAt(i) === 0x2d) i++;
    const first = src.charCodeAt(i);
    if (first === 0x30) {
      i++;
    } else if (first >= 0x31 && first <= 0x39) {
      while (isDigit(src.charCodeAt(i))) i++;
    } else {
      unexpected();
    }
    if (src.charCodeAt(i) === 0x2e) {
      i++;
      if (!isDigit(src.charCodeAt(i))) unexpected();
      while (isDigit(src.charCodeAt(i))) i++;
    }
    const e = src.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      i++;
      const sign = src.charCodeAt(i);
      if (sign === 0x2b || sign === 0x2d) i++;
      if (!isDigit(src.charCodeAt(i))) unexpected();
      while (isDigit(src.charCodeAt(i))) i++;
    }
    return Number(src.slice(start, i));
  };

  const readLiteral = (word: string, value: boolean | null): JsonNode => {
    const start = i;
    if (!src.startsWith(word, i)) unexpected();
    i += word.length;
    return { kind: "scalar", start, end: i, value };
  };

  const readValue = (): JsonNode => {
    const start = i;
    const c = src.charCodeAt(i);
    if (c === 0x7b) return readObject();
    if (c === 0x5b) return readArray();
    if (c === 0x22) {
      const value = readString();
      return { kind: "scalar", start, end: i, value };
    }
    if (c === 0x2d || isDigit(c)) {
      const value = readNumber();
      return { kind: "scalar", start, end: i, value };
    }
    if (c === 0x74) return readLiteral("true", true);
    if (c === 0x66) return readLiteral("false", false);
    if (c === 0x6e) return readLiteral("null", null);
    return unexpected();
  };

  const readObject = (): JsonNode => {
    const start = i;
    i++;
    const entries: JsonEntry[] = [];
    const value: Record<string, unknown> = {};
    skipSpace();
    if (src.charCodeAt(i) === 0x7d) {
      i++;
      return { kind: "object", start, end: i, value, entries };
    }
    for (;;) {
      skipSpace();
      if (src.charCodeAt(i) !== 0x22) unexpected();
      const keyStart = i;
      const key = readString();
      const keyEnd = i;
      skipSpace();
      if (src.charCodeAt(i) !== 0x3a) unexpected();
      i++;
      skipSpace();
      const child = readValue();
      entries.push({ key, keyStart, keyEnd, value: child });
      setOwn(value, key, child.value);
      skipSpace();
      const sep = src.charCodeAt(i);
      if (sep === 0x2c) {
        i++;
        continue;
      }
      if (sep === 0x7d) {
        i++;
        return { kind: "object", start, end: i, value, entries };
      }
      unexpected();
    }
  };

  const readArray = (): JsonNode => {
    const start = i;
    i++;
    const items: JsonNode[] = [];
    const value: unknown[] = [];
    skipSpace();
    if (src.charCodeAt(i) === 0x5d) {
      i++;
      return { kind: "array", start, end: i, value, items };
    }
    for (;;) {
      skipSpace();
      const child = readValue();
      items.push(child);
      value.push(child.value);
      skipSpace();
      const sep = src.charCodeAt(i);
      if (sep === 0x2c) {
        i++;
        continue;
      }
      if (sep === 0x5d) {
        i++;
        return { kind: "array", start, end: i, value, items };
      }
      unexpected();
    }
  };

  skipSpace();
  const root = readValue();
  skipSpace();
  if (i < n) unexpected();
  return root;
}

export function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
