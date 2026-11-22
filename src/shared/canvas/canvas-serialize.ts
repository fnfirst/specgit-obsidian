import {
  deepEqual,
  getOwn,
  hasOwn,
  isDefaultEnd,
  isUnchanged,
  itemEntries,
  obsidianKeyOrder,
  type CanvasItem,
} from "./canvas-model";
import {
  defaultSep,
  objectLayout,
  obsidianArrayLayout,
  obsidianExpands,
  obsidianItemLayout,
  obsidianTopLayout,
  obsidianValueText,
} from "./canvas-format";
import type { CanvasArrayLayout, CanvasDoc, CanvasFormat, CanvasObjectLayout } from "./canvas-types";

export const EMPTY_CANVAS_SOURCE = "{}";

const DEFAULT_FORMAT: CanvasFormat = { newline: "\n", head: "", tail: "", obsidian: true };

type Entry = [key: string, value: string];

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

function joinObject(layout: CanvasObjectLayout, entries: readonly Entry[]): string {
  if (entries.length === 0) return "{}";
  return layout.open + entries.map(([key, value]) => key + layout.colon + value).join(layout.sep) + layout.close;
}

function joinArray(layout: CanvasArrayLayout, items: readonly CanvasItem[], texts: readonly string[]): string {
  let out = layout.open + (texts[0] ?? "");
  for (let i = 1; i < texts.length; i++) {
    const prev = items[i - 1]?.origin?.index;
    const adjacent = prev !== undefined && items[i]?.origin?.index === prev + 1;
    out += (adjacent ? layout.seps[prev] : undefined) ?? layout.seps[0] ?? defaultSep(layout.open);
    out += texts[i];
  }
  return out + layout.close;
}

function emitItem(
  item: CanvasItem,
  order: readonly string[] | undefined,
  layout: (values: Iterable<unknown>) => CanvasObjectLayout,
  obsidian: { newline: string } | null,
): string {
  const { origin } = item;
  if (origin && isUnchanged(item, origin)) return origin.text;
  const keys = itemEntries(item, order).filter(([key, value]) => !(obsidian && !origin && isDefaultEnd(key, value)));
  const place = layout(keys.map(([, value]) => value));
  const valueText = (value: unknown): string => (obsidian ? obsidianValueText(value, obsidian.newline, 3) : stringify(value));
  if (!origin) return joinObject(place, keys.map(([key, value]) => [JSON.stringify(key), valueText(value)]));
  const lastOf = new Map(origin.entries.map((e) => [e.key, e]));
  return joinObject(
    place,
    keys.map(([key, value]): Entry => {
      const prev = lastOf.get(key);
      if (prev && deepEqual(getOwn(origin.value, key), value)) {
        return [origin.text.slice(prev.keyStart, prev.keyEnd), origin.text.slice(prev.valueStart, prev.valueEnd)];
      }
      return [JSON.stringify(key), valueText(value)];
    }),
  );
}

function ownLayout(item: CanvasItem): CanvasObjectLayout | null {
  return item.origin ? objectLayout(item.origin.text, item.origin.entries) : null;
}

function neighbourOrder(items: readonly CanvasItem[], i: number): readonly string[] | undefined {
  const type = (item: CanvasItem | undefined): string | undefined => (item && "type" in item ? item.type : undefined);
  const order = (item: CanvasItem | undefined): readonly string[] | undefined => item?.keyOrder;
  const near = items.map((_, d) => [items[i - d], items[i + d]]).flat().filter((item): item is CanvasItem => item?.keyOrder !== undefined);
  return order(near.find((item) => type(item) === type(items[i]))) ?? order(near[0]);
}

function emitItems(items: readonly CanvasItem[], format: CanvasFormat, sibling: CanvasObjectLayout | undefined): string[] {
  const own = items.map(ownLayout);
  const nearest = (i: number): CanvasObjectLayout | undefined => {
    for (let p = i; p >= 0; p--) if (own[p]) return own[p] ?? undefined;
    for (let q = i + 1; q < own.length; q++) if (own[q]) return own[q] ?? undefined;
    return sibling;
  };
  return items.map((item, i) =>
    emitItem(item, format.obsidian ? obsidianKeyOrder(item) : item.origin ? item.keyOrder : neighbourOrder(items, i), (values) => {
      const written = obsidianItemLayout(obsidianExpands(values), format.newline);
      return format.obsidian ? written : (nearest(i) ?? written);
    }, format.obsidian ? format : null),
  );
}

function extraValueText(key: string, value: unknown, format: CanvasFormat): string {
  const raw = getOwn(format.extraSource, key);
  if (typeof raw === "string") {
    try {
      if (deepEqual(JSON.parse(raw), value)) return raw;
    } catch {
      return stringify(value);
    }
  }
  return stringify(value);
}

function topLevelKeys(canvas: CanvasDoc, extraKeys: readonly string[], counts: { nodes: number; edges: number }): string[] {
  const order = canvas.keyOrder ?? [];
  const fresh = order.length === 0;
  const keys: string[] = [];
  for (const key of order) {
    if (keys.includes(key)) continue;
    if (key === "nodes" || key === "edges" || extraKeys.includes(key)) keys.push(key);
  }
  if (!keys.includes("nodes") && (fresh || counts.nodes > 0)) keys.push("nodes");
  if (!keys.includes("edges") && (fresh || counts.edges > 0)) keys.push("edges");
  for (const key of extraKeys) if (!keys.includes(key)) keys.push(key);
  return keys;
}

export function serializeCanvas(canvas: CanvasDoc): string {
  const format = canvas.format ?? DEFAULT_FORMAT;
  const { nodes, edges } = canvas;
  const extra = canvas.extra ?? {};
  const extraKeys = Object.keys(extra).filter((k) => extra[k] !== undefined);
  const { newline, head, tail } = format;

  if (nodes.length === 0 && edges.length === 0 && extraKeys.length === 0) {
    if (typeof format.emptySource === "string") return format.emptySource;
    if (!canvas.keyOrder || canvas.keyOrder.length === 0) return head + EMPTY_CANVAS_SOURCE + tail;
  }

  const top = format.top ?? obsidianTopLayout(newline);
  const arrays = format.arrays ?? {};
  const aligned = (key: "nodes" | "edges"): CanvasArrayLayout =>
    arrays[key] ?? arrays[key === "nodes" ? "edges" : "nodes"] ?? (top.open.includes("\n") ? obsidianArrayLayout(newline) : { open: "[", seps: [], close: "]" });
  const sibling = (items: readonly CanvasItem[]): CanvasObjectLayout | undefined => items.map(ownLayout).find((layout) => layout !== null) ?? undefined;
  const keys = topLevelKeys(canvas, extraKeys, { nodes: nodes.length, edges: edges.length });
  const entries = keys.map((key): Entry => {
    if (key !== "nodes" && key !== "edges") return [JSON.stringify(key), extraValueText(key, extra[key], format)];
    const items: readonly CanvasItem[] = key === "nodes" ? nodes : edges;
    if (items.length === 0) return [JSON.stringify(key), hasOwn(extra, key) ? extraValueText(key, extra[key], format) : "[]"];
    const texts = emitItems(items, format, sibling(key === "nodes" ? edges : nodes));
    return [JSON.stringify(key), joinArray(aligned(key), items, texts)];
  });
  return head + joinObject(top, entries) + tail;
}
