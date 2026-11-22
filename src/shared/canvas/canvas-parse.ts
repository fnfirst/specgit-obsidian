import {
  isJsonWhitespace,
  JsonSyntaxError,
  lineAt,
  lineStarts,
  parseJsonSpans,
  setOwn,
  type JsonNode,
} from "./canvas-json";
import {
  fieldsOf,
  getOwn,
  hasOwn,
  itemFromOrigin,
  originOf,
  resolveField,
  type CanvasItem,
  type FieldState,
  type ItemKind,
  type Raw,
} from "./canvas-model";
import { arrayLayout, isObsidianArray, objectLayout, obsidianExpands, obsidianItemLayout, obsidianTopLayout, sameObjectLayout } from "./canvas-format";
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasFormat,
  CanvasIssue,
  CanvasLineIndex,
  CanvasNode,
  CanvasParseResult,
} from "./canvas-types";

const BOM = "\uFEFF";

function detectNewline(src: string): "\n" | "\r\n" {
  const at = src.indexOf("\n");
  return at > 0 && src.charCodeAt(at - 1) === 0x0d ? "\r\n" : "\n";
}

function jsonIssue(src: string, err: JsonSyntaxError): CanvasIssue {
  const starts = lineStarts(src.startsWith(BOM) ? src.slice(1) : src);
  const line = lineAt(starts, err.offset);
  const column = err.offset - (starts[line - 1] ?? 0) + 1;
  return { code: "json", line, message: `Invalid JSON: ${err.message} (line ${line}, column ${column})` };
}

export function parseCanvas(src: string): CanvasParseResult {
  try {
    return parseCanvasSource(typeof src === "string" ? src : "");
  } catch (err) {
    if (err instanceof JsonSyntaxError) return { ok: false, issues: [jsonIssue(src, err)] };
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, issues: [{ code: "json", line: null, message: `Could not read the board: ${message}` }] };
  }
}

function parseCanvasSource(src: string): CanvasParseResult {
  const bom = src.startsWith(BOM);
  const body = bom ? src.slice(1) : src;
  const newline = detectNewline(body);
  const format: CanvasFormat = { newline, head: bom ? BOM : "", tail: "", obsidian: true };

  if (isJsonWhitespace(body)) {
    if (body.endsWith("\n")) format.tail = newline;
    format.emptySource = src;
    return { ok: true, canvas: { nodes: [], edges: [], keyOrder: [], format }, issues: [] };
  }

  const root = parseJsonSpans(body);
  const starts = lineStarts(body);
  if (root.kind !== "object") {
    return {
      ok: false,
      issues: [{ code: "not_object", line: lineAt(starts, root.start), message: "A canvas must be a JSON object." }],
    };
  }

  format.head += body.slice(0, root.start);
  format.tail = body.slice(root.end);
  const issues: CanvasIssue[] = [];
  const canvas: CanvasDoc = { nodes: [], edges: [], keyOrder: [], format };
  const keyOrder: string[] = [];
  const extra: Raw = {};
  const extraSource: Record<string, string> = {};

  for (const entry of root.entries) {
    if (!keyOrder.includes(entry.key)) keyOrder.push(entry.key);
    const raw = body.slice(entry.value.start, entry.value.end);
    if (entry.key === "nodes" || entry.key === "edges") {
      const key = entry.key;
      delete extra[key];
      delete extraSource[key];
      if (entry.value.kind === "array") {
        const layout = arrayLayout(body, entry.value);
        if (layout) format.arrays = { ...format.arrays, [key]: layout };
        if (key === "nodes") canvas.nodes = readItems(entry.value, "node", body, starts, issues) as CanvasNode[];
        else canvas.edges = readItems(entry.value, "edge", body, starts, issues) as CanvasEdge[];
      } else {
        if (key === "nodes") canvas.nodes = [];
        else canvas.edges = [];
        setOwn(extra, key, entry.value.value);
        extraSource[key] = raw;
        issues.push({
          code: "invalid_value",
          line: lineAt(starts, entry.value.start),
          message: `"${key}" must be an array; the board shows none.`,
        });
      }
      continue;
    }
    setOwn(extra, entry.key, entry.value.value);
    setOwn(extraSource, entry.key, raw);
  }

  canvas.keyOrder = keyOrder;
  if (Object.keys(extra).length > 0) {
    canvas.extra = extra;
    format.extraSource = extraSource;
  }
  if (root.entries.length === 0) format.emptySource = src;

  const rootOrigin = originOf(body.slice(root.start, root.end), root, 1);
  const top = objectLayout(rootOrigin.text, rootOrigin.entries);
  if (top) format.top = top;
  format.obsidian =
    [...canvas.nodes, ...canvas.edges].every((item) => isObsidianItem(item, newline)) &&
    (!top || sameObjectLayout(top, obsidianTopLayout(newline))) &&
    Object.values(format.arrays ?? {}).every((layout) => isObsidianArray(layout, newline));

  issues.push(...validateCanvas(canvas));
  return { ok: true, canvas, issues };
}

function isObsidianItem(item: CanvasItem, newline: string): boolean {
  const { origin } = item;
  const layout = origin && objectLayout(origin.text, origin.entries);
  return !origin || !layout || sameObjectLayout(layout, obsidianItemLayout(obsidianExpands(Object.values(origin.value)), newline));
}

function readItems(
  array: Extract<JsonNode, { kind: "array" }>,
  kind: ItemKind,
  body: string,
  starts: readonly number[],
  issues: CanvasIssue[],
): CanvasItem[] {
  const out: CanvasItem[] = [];
  for (const [index, node] of array.items.entries()) {
    const line = lineAt(starts, node.start);
    if (node.kind !== "object") {
      issues.push({
        code: "invalid_value",
        line,
        message: `A ${kind} must be a JSON object; this entry is skipped and will not be saved.`,
      });
      continue;
    }
    const origin = originOf(body.slice(node.start, node.end), node, line, index);
    const item = itemFromOrigin(kind, origin);
    item.origin = origin;
    out.push(item);
  }
  return out;
}

export function canvasLineIndex(src: string): CanvasLineIndex {
  const index: CanvasLineIndex = { nodes: {}, edges: {} };
  if (typeof src !== "string") return index;
  const body = src.startsWith(BOM) ? src.slice(1) : src;
  let root: JsonNode;
  try {
    root = parseJsonSpans(body);
  } catch {
    return index;
  }
  if (root.kind !== "object") return index;
  const starts = lineStarts(body);
  for (const entry of root.entries) {
    if ((entry.key !== "nodes" && entry.key !== "edges") || entry.value.kind !== "array") continue;
    const target = entry.key === "nodes" ? index.nodes : index.edges;
    for (const item of entry.value.items) {
      if (item.kind !== "object") continue;
      const id = getOwn(item.value, "id");
      if (typeof id !== "string" || hasOwn(target, id)) continue;
      setOwn(target, id, lineAt(starts, item.start));
    }
  }
  return index;
}

export function canvasItemAtLine(index: CanvasLineIndex, line: number): string | null {
  let best: { id: string; line: number } | null = null;
  for (const [id, start] of [...Object.entries(index.nodes), ...Object.entries(index.edges)]) {
    if (start <= line && (!best || start > best.line)) best = { id, line: start };
  }
  return best?.id ?? null;
}

export function canvasLineOfItem(index: CanvasLineIndex, id: string): number | null {
  if (hasOwn(index.nodes, id)) return index.nodes[id] ?? null;
  if (hasOwn(index.edges, id)) return index.edges[id] ?? null;
  return null;
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export function validateCanvas(canvas: CanvasDoc): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  const seen = new Set<string>();
  const nodeIds = new Set(canvas.nodes.map((node) => node.id).filter((id) => id !== ""));

  const checkItem = (item: CanvasItem, kind: ItemKind): void => {
    const line = item.origin?.line ?? null;
    const label = kind === "node" ? "Node" : "Edge";
    const { id } = item;
    const push = (code: CanvasIssue["code"], message: string): void => {
      issues.push(id ? { code, message, line, id } : { code, message, line });
    };
    if (id !== "") {
      if (seen.has(id)) push("duplicate_id", `Id "${id}" is used by more than one node or edge.`);
      seen.add(id);
    }
    const name = id ? `${label} "${id}"` : `${label} without an id`;
    if (kind === "node") {
      const node = item as CanvasNode;
      if (node.type === "unknown" && !node.rawType) {
        const rawType = getOwn(node.extra, "type");
        if (rawType === undefined || rawType === null) push("missing_field", `${name} is missing "type".`);
        else push("invalid_value", `${name} has an invalid "type": ${preview(rawType)}.`);
      }
    }
    const states = new Map<string, FieldState>();
    for (const spec of fieldsOf(item)) {
      if (spec.key === "type") continue;
      const { key } = spec;
      const { state } = resolveField(item, spec);
      states.set(key, state);
      if (state === "missing") push("missing_field", `${name} is missing "${key}".`);
      else if (state === "invalid") {
        const bad = getOwn(item.extra, key) ?? getOwn(item, key);
        push("invalid_value", `${name} has an invalid "${key}": ${preview(bad)}.`);
      }
    }
    if (kind === "edge") {
      const edge = item as CanvasEdge;
      for (const end of ["fromNode", "toNode"] as const) {
        const target = edge[end];
        if (states.get(end) !== "ok") continue;
        if (!nodeIds.has(target)) push("dangling_edge", `${name} points at missing node "${target}".`);
      }
    }
  };

  for (const node of canvas.nodes) checkItem(node, "node");
  for (const edge of canvas.edges) checkItem(edge, "edge");
  return issues;
}
