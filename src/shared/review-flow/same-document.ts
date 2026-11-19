const BOM = "\uFEFF";
const toLf = (text: string): string => text.replace(/\r\n/g, "\n");
const withoutBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

const trimBlanks = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/g, "");
const isFence = (line: string | undefined): boolean => line !== undefined && /^---[ \t]*$/.test(line);

function split(text: string): { front: string | null; body: string } {
  const lines = text.split("\n");
  if (!isFence(lines[0])) return { front: null, body: text };
  for (let at = 1; at < lines.length; at++) {
    if (isFence(lines[at])) return { front: lines.slice(1, at).join("\n"), body: lines.slice(at + 1).join("\n") };
  }
  return { front: null, body: text };
}

function plain(value: string): string | null {

  return /^["'|>&*!{[#%@`]/.test(value) || /^[-?](?:[ \t]|$)/.test(value) || /\s#/.test(value) ? null : value;
}

function shapeOf(front: string): string | null {
  const lines = front.split("\n");
  const entries: Array<[string, string | string[]]> = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;

    if (/^ *$/.test(line)) continue;
    const entry = /^([^\s#:"'[\]{}-][^:]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!entry) return null;
    const key = trimBlanks(entry[1]!);
    const value = trimBlanks(entry[2] ?? "");
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      if (/["'[\]{}]/.test(inner)) return null;
      const items = trimBlanks(inner) === "" ? [] : inner.split(",").map(trimBlanks);
      if (items.some((item) => item === "" || plain(item) === null || /:/.test(item))) return null;
      entries.push([key, items]);
    } else if (value === "") {
      const items: string[] = [];
      let column: string | null = null;
      for (let next; at + 1 < lines.length && (next = /^( *)-[ \t]+(\S.*)$/.exec(lines[at + 1]!)); at++) {

        if (column !== null && next[1] !== column) return null;
        column = next[1]!;
        const item = trimBlanks(next[2]!);
        if (plain(item) === null || /:/.test(item)) return null;
        items.push(item);
      }
      entries.push([key, items.length > 0 ? items : ""]);
    } else {
      const scalar = plain(value);
      if (scalar === null) return null;
      entries.push([key, scalar]);
    }
  }
  return JSON.stringify(entries);
}

export const opensUnclosedFence = (body: string): boolean => body.split("\n").filter((line) => /^ {0,3}(?:```|~~~)/.test(line)).length % 2 === 1;

const bodyOf = (body: string, afterFront: boolean): string => {
  const start = afterFront ? body.replace(/^\n+/, "") : body;
  return opensUnclosedFence(start) ? start : start.replace(/\n+$/, "");
};

export function sameDocumentText(base: string, source: string): boolean {
  const a = split(toLf(withoutBom(base)));
  const b = split(toLf(withoutBom(source)));
  if ((a.front === null) !== (b.front === null)) return false;
  if (bodyOf(a.body, a.front !== null) !== bodyOf(b.body, b.front !== null)) return false;
  if (a.front === null || a.front === b.front) return true;
  const shape = shapeOf(a.front);
  return shape !== null && shape === shapeOf(b.front!);
}
