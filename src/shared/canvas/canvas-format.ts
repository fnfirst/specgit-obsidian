import type { JsonNode } from "./canvas-json";
import type { CanvasArrayLayout, CanvasObjectLayout, CanvasOriginEntry } from "./canvas-types";

export function defaultSep(open: string): string {
  return `,${open.slice(1)}`;
}

export function objectLayout(text: string, entries: readonly CanvasOriginEntry[]): CanvasObjectLayout | null {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) return null;
  const second = entries[1];
  const open = text.slice(0, first.keyStart);
  return {
    open,
    colon: text.slice(first.keyEnd, first.valueStart),
    sep: second ? text.slice(first.valueEnd, second.keyStart) : defaultSep(open),
    close: text.slice(last.valueEnd),
  };
}

export function arrayLayout(src: string, array: Extract<JsonNode, { kind: "array" }>): CanvasArrayLayout | null {
  const first = array.items[0];
  const last = array.items[array.items.length - 1];
  if (!first || !last) return null;
  return {
    open: src.slice(array.start, first.start),
    seps: array.items.slice(1).map((item, i) => src.slice(array.items[i]?.end ?? item.start, item.start)),
    close: src.slice(last.end, array.end),
  };
}

export function obsidianItemLayout(expanded: boolean, newline: string): CanvasObjectLayout {
  if (!expanded) return { open: "{", sep: ",", colon: ":", close: "}" };
  const inner = `${newline}\t\t\t`;
  return { open: `{${inner}`, sep: `,${inner}`, colon: ":", close: `${newline}\t\t}` };
}

export function obsidianArrayLayout(newline: string): CanvasArrayLayout {
  return { open: `[${newline}\t\t`, seps: [], close: `${newline}\t]` };
}

export function obsidianTopLayout(newline: string): CanvasObjectLayout {
  return { open: `{${newline}\t`, sep: `,${newline}\t`, colon: ":", close: `${newline}}` };
}

export function obsidianExpands(values: Iterable<unknown>): boolean {
  for (const value of values) if (typeof value === "object") return true;
  return false;
}

export function sameObjectLayout(a: CanvasObjectLayout, b: CanvasObjectLayout): boolean {
  return a.open === b.open && a.sep === b.sep && a.colon === b.colon && a.close === b.close;
}

export function isObsidianArray(layout: CanvasArrayLayout, newline: string): boolean {
  const want = obsidianArrayLayout(newline);
  return layout.open === want.open && layout.close === want.close && layout.seps.every((sep) => sep === defaultSep(layout.open));
}

export function obsidianValueText(value: unknown, newline: string, depth: number): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const members: Array<[string | null, unknown]> = Array.isArray(value)
    ? value.map((v): [string | null, unknown] => [null, v])
    : Object.entries(value as Record<string, unknown>);
  if (!obsidianExpands(members.map(([, v]) => v))) return JSON.stringify(value);
  const inner = `${newline}${"\t".repeat(depth + 1)}`;
  const text = members.map(([key, v]) => (key === null ? "" : `${JSON.stringify(key)}:`) + obsidianValueText(v, newline, depth + 1)).join(`,${inner}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}${inner}${text}${newline}${"\t".repeat(depth)}${close}`;
}
