import { diffCanvas, isCanvasConflictField, isCanvasItemConflict } from "./canvas-merge";
import { hasOwn, itemsEquivalent } from "./canvas-model";
import type {
  CanvasConflict,
  CanvasConflictChoice,
  CanvasConflictField,
  CanvasEdge,
  CanvasFieldConflict,
  CanvasItemConflict,
  CanvasMergeResult,
  CanvasNode,
} from "./canvas-types";

export interface CanvasConflictValue {
  text: string;
  colorKey?: string;
  block?: boolean;
  empty?: boolean;
}

export interface CanvasReadableConflict {
  conflict: CanvasConflict;
  label: string;
  reason: string;
  ours: CanvasConflictValue;
  theirs: CanvasConflictValue;
}

export interface CanvasConflictGroup {
  key: string;
  itemKind: "node" | "edge";
  id: string;
  focusId: string | null;
  kind: string;
  title: string;
  conflicts: CanvasReadableConflict[];
}

export const CANVAS_COLOR_LABELS: Readonly<Record<string, string>> = {
  "1": "Red",
  "2": "Orange",
  "3": "Yellow",
  "4": "Green",
  "5": "Cyan",
  "6": "Purple",
};

const FIELD_LABELS: Record<CanvasConflictField, string> = {
  position: "Position",
  size: "Size",
  text: "Text",
  file: "File",
  subpath: "Heading",
  url: "Web address",
  label: "Label",
  color: "Color",
  background: "Background image",
  backgroundStyle: "Background style",
  type: "Card type",
  fromNode: "Start card",
  toNode: "End card",
  fromSide: "Start side",
  toSide: "End side",
  fromEnd: "Start arrowhead",
  toEnd: "End arrowhead",
};

const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_EXT = /\.(?:mp3|wav|ogg|m4a|flac|3gp)$/i;
const DOC_EXT = /\.(?:md|markdown|html|htm)$/i;
const TITLE_EXT = /\.(?:md|markdown|mdx)$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type CanvasFileKind = "note" | "image" | "audio" | "video" | "board" | "base" | "other";

function canvasFileKind(path: string): CanvasFileKind {
  if (IMAGE_DATA_URL.test(path) || IMAGE_EXT.test(path)) return "image";
  if (VIDEO_EXT.test(path)) return "video";
  if (AUDIO_EXT.test(path)) return "audio";
  if (/\.canvas$/i.test(path)) return "board";
  if (/\.base$/i.test(path)) return "base";
  if (DOC_EXT.test(path)) return "note";
  return "other";
}

const FILE_KIND_LABELS: Record<CanvasFileKind, string> = {
  note: "Note",
  image: "Image",
  audio: "Audio",
  video: "Video",
  board: "Board",
  base: "Base",
  other: "File",
};

export function canvasNodeKind(node: CanvasNode): string {
  switch (node.type) {
    case "text":
      return "Text card";
    case "file":
      return FILE_KIND_LABELS[canvasFileKind(node.file)];
    case "link":
      return "Link";
    case "group":
      return "Group";
    case "unknown":
      return "Card";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function fileTitle(path: string): string {
  if (IMAGE_DATA_URL.test(path)) return "Pasted image";
  const base = path.split("/").pop() ?? path;
  return (base || path).replace(TITLE_EXT, "");
}

function nodeSummary(node: CanvasNode): string {
  switch (node.type) {
    case "text":
      return node.text.split("\n").find((line) => line.trim() !== "")?.replace(/^#+\s*/, "") ?? "";
    case "file":
      return fileTitle(node.file);
    case "link":
      return hostOf(node.url);
    case "group":
      return node.label ?? "";
    case "unknown":
      return node.rawType;
  }
}

function knownNodes(result: CanvasMergeResult): Map<string, CanvasNode> {
  const out = new Map<string, CanvasNode>();
  for (const conflict of result.conflicts) {
    if (!isCanvasItemConflict(conflict) || conflict.itemKind !== "node") continue;
    for (const node of [conflict.base, conflict.theirs, conflict.ours]) if (node) out.set(node.id, node);
  }
  for (const node of result.ours.nodes) out.set(node.id, node);
  for (const node of result.theirs.nodes) out.set(node.id, node);
  for (const node of result.merged.nodes) out.set(node.id, node);
  return out;
}

function knownEdges(result: CanvasMergeResult): Map<string, CanvasEdge> {
  const out = new Map<string, CanvasEdge>();
  for (const conflict of result.conflicts) {
    if (!isCanvasItemConflict(conflict) || conflict.itemKind !== "edge") continue;
    for (const edge of [conflict.base, conflict.theirs, conflict.ours]) if (edge) out.set(edge.id, edge);
  }
  for (const edge of result.ours.edges) out.set(edge.id, edge);
  for (const edge of result.theirs.edges) out.set(edge.id, edge);
  for (const edge of result.merged.edges) out.set(edge.id, edge);
  return out;
}

function nodeTitle(node: CanvasNode | undefined, id: string): string {
  const summary = node ? nodeSummary(node).trim() : "";
  if (summary) return summary.length > 60 ? `${summary.slice(0, 59)}…` : summary;
  return node ? `Untitled ${canvasNodeKind(node).toLowerCase()}` : id;
}

function edgeTitle(edge: CanvasEdge, nodes: ReadonlyMap<string, CanvasNode>): string {
  const route = `${nodeTitle(nodes.get(edge.fromNode), edge.fromNode)} → ${nodeTitle(nodes.get(edge.toNode), edge.toNode)}`;
  return edge.label?.trim() ? `“${edge.label.trim()}” (${route})` : route;
}

function fieldLabel(conflict: CanvasConflict): string {
  if (!isCanvasItemConflict(conflict)) return isCanvasConflictField(conflict.field) ? FIELD_LABELS[conflict.field] : conflict.field;
  return conflict.itemKind === "edge" ? "Whole arrow" : "Whole card";
}

function reasonText(conflict: CanvasConflict): string {
  const thing = conflict.itemKind === "edge" ? "arrow" : "card";
  if (conflict.reason === "both_changed") {
    return conflict.field === "*" ? `Both versions added this ${thing}, differently.` : "Both versions changed this.";
  }
  const kept = conflict.ours ?? conflict.theirs;
  const viaArrow = conflict.itemKind === "node" && kept !== null && conflict.base !== null && itemsEquivalent(kept, conflict.base);
  if (conflict.ours === null) {
    return viaArrow ? "You deleted this card; the other version drew or changed an arrow to it." : `You deleted this ${thing}; the other version edited it.`;
  }
  return viaArrow ? "The other version deleted this card; you drew or changed an arrow to it." : `You edited this ${thing}; the other version deleted it.`;
}

function num(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "?";
}

function itemValue(conflict: CanvasItemConflict, side: CanvasConflictChoice, nodes: ReadonlyMap<string, CanvasNode>): CanvasConflictValue {
  if (conflict.itemKind === "edge") {
    const edge = side === "ours" ? conflict.ours : conflict.theirs;
    return edge ? { text: `Arrow ${edgeTitle(edge, nodes)}` } : { text: "No arrow", empty: true };
  }
  const node = side === "ours" ? conflict.ours : conflict.theirs;
  if (!node) return { text: "Deleted", empty: true };
  const text = node.type === "text" ? node.text : nodeTitle(node, node.id);
  return { text: `${canvasNodeKind(node)} at ${num(node.x)}, ${num(node.y)}${text ? `\n${text}` : ""}`, block: true };
}

function fieldValue(field: CanvasFieldConflict["field"], value: unknown): CanvasConflictValue {
  if (value === undefined || value === null) {
    if (field === "color") return { text: "No color" };
    if (field === "toEnd") return { text: "Arrow (default)" };
    if (field === "fromEnd") return { text: "None (default)" };
    return { text: "Not set", empty: true };
  }
  if (field === "position" && isRecord(value)) return { text: `x ${num(value.x)}, y ${num(value.y)}` };
  if (field === "size" && isRecord(value)) return { text: `${num(value.width)} × ${num(value.height)}` };
  if (field === "color" && typeof value === "string") {
    const label = hasOwn(CANVAS_COLOR_LABELS, value) ? CANVAS_COLOR_LABELS[value]! : value;
    return { text: label, colorKey: value };
  }
  if ((field === "fromEnd" || field === "toEnd") && typeof value === "string") return { text: value === "arrow" ? "Arrow" : value === "none" ? "None" : value };
  if (typeof value === "string") {
    const isText = field === "text";
    return value === ""
      ? { text: "Empty", empty: true, ...(isText ? { block: true } : {}) }
      : { text: value, ...(isText ? { block: true } : {}) };
  }
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value) };
  return { text: JSON.stringify(value), block: true };
}

function sideValue(conflict: CanvasConflict, side: CanvasConflictChoice, nodes: ReadonlyMap<string, CanvasNode>): CanvasConflictValue {
  return isCanvasItemConflict(conflict) ? itemValue(conflict, side, nodes) : fieldValue(conflict.field, side === "ours" ? conflict.ours : conflict.theirs);
}

export function canvasConflictGroups(result: CanvasMergeResult): CanvasConflictGroup[] {
  const nodes = knownNodes(result);
  const edges = knownEdges(result);
  const groups = new Map<string, CanvasConflictGroup>();
  for (const conflict of result.conflicts) {
    const key = `${conflict.itemKind}:${conflict.id}`;
    const row: CanvasReadableConflict = {
      conflict,
      label: fieldLabel(conflict),
      reason: reasonText(conflict),
      ours: sideValue(conflict, "ours", nodes),
      theirs: sideValue(conflict, "theirs", nodes),
    };
    const existing = groups.get(key);
    if (existing) {
      existing.conflicts.push(row);
      continue;
    }
    if (conflict.itemKind === "node") {
      const node = nodes.get(conflict.id);
      groups.set(key, {
        key,
        itemKind: "node",
        id: conflict.id,
        focusId: conflict.id,
        kind: node ? canvasNodeKind(node) : "Card",
        title: nodeTitle(node, conflict.id),
        conflicts: [row],
      });
    } else {
      const edge = edges.get(conflict.id);
      groups.set(key, {
        key,
        itemKind: "edge",
        id: conflict.id,
        focusId: edge ? (nodes.has(edge.fromNode) ? edge.fromNode : nodes.has(edge.toNode) ? edge.toNode : null) : null,
        kind: "Arrow",
        title: edge ? edgeTitle(edge, nodes) : conflict.id,
        conflicts: [row],
      });
    }
  }
  return [...groups.values()];
}

export function chooseAllCanvasConflicts(result: CanvasMergeResult, choice: CanvasConflictChoice): Record<string, CanvasConflictChoice> {
  return Object.fromEntries(result.conflicts.map((conflict) => [conflict.key, choice]));
}

export function canvasCleanSummary(result: CanvasMergeResult): string[] {
  const diff = diffCanvas(result.ours, result.merged);
  const nodes = knownNodes(result);
  const edges = knownEdges(result);
  const lines: string[] = [];
  for (const change of diff.nodes) {
    const node = nodes.get(change.id);
    const kind = node ? canvasNodeKind(node).toLowerCase() : "card";
    const title = nodeTitle(node, change.id);
    if (change.kind === "added") lines.push(`Added ${kind}: ${title}`);
    else if (change.kind === "removed") lines.push(`Removed ${kind}: ${title}`);
    else lines.push(`Updated ${kind}: ${title}`);
  }
  for (const change of diff.edges) {
    const edge = edges.get(change.id);
    const title = edge ? edgeTitle(edge, nodes) : change.id;
    if (change.kind === "added") lines.push(`Added arrow: ${title}`);
    else if (change.kind === "removed") lines.push(`Removed arrow: ${title}`);
    else lines.push(`Updated arrow: ${title}`);
  }
  return lines;
}
