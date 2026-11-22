import { setOwn, type JsonNode } from "./canvas-json";
import {
  CANVAS_SIDES,
  type CanvasBackgroundStyle,
  type CanvasChangeField,
  type CanvasConflictField,
  type CanvasEdge,
  type CanvasEnd,
  type CanvasNode,
  type CanvasNodeType,
  type CanvasOrigin,
  type CanvasSide,
} from "./canvas-types";

export type Raw = Record<string, unknown>;
export type CanvasItem = CanvasNode | CanvasEdge;
export type ItemKind = "node" | "edge";

const CANVAS_COLOR_BODY = "[1-6]|#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})";

export const CANVAS_COLOR_RE =   new RegExp(`^(?:${CANVAS_COLOR_BODY})$`);

export const CANVAS_COLOR_INPUT_RE =   new RegExp(`^(?:none|${CANVAS_COLOR_BODY})$`);

type FieldKind = "string" | "nonEmptyString" | "subpath" | "color" | "integer" | "side" | "end" | "backgroundStyle";

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  required: boolean;
  change: CanvasChangeField | null;
  conflict: CanvasConflictField | null;
}

const req = (key: CanvasConflictField, kind: FieldKind, change: CanvasChangeField): FieldSpec => ({ key, kind, required: true, change, conflict: key });
const opt = (key: CanvasConflictField, kind: FieldKind, change: CanvasChangeField): FieldSpec => ({ key, kind, required: false, change, conflict: key });
const geometry = (key: string, pair: "position" | "size"): FieldSpec => ({ key, kind: "integer", required: true, change: pair, conflict: pair });

const ID: FieldSpec = { key: "id", kind: "nonEmptyString", required: true, change: null, conflict: null };
const TYPE = req("type", "string", "type");
const GEOMETRY = [geometry("x", "position"), geometry("y", "position"), geometry("width", "size"), geometry("height", "size")];
const COLOR = opt("color", "color", "color");
const LABEL = opt("label", "string", "label");

const FIELDS: Record<CanvasNodeType | "edge", readonly FieldSpec[]> = {
  text: [ID, TYPE, req("text", "string", "text"), ...GEOMETRY, COLOR],
  file: [ID, TYPE, req("file", "string", "file"), opt("subpath", "subpath", "file"), ...GEOMETRY, COLOR],
  link: [ID, TYPE, req("url", "string", "url"), ...GEOMETRY, COLOR],
  group: [ID, TYPE, opt("backgroundStyle", "backgroundStyle", "background"), ...GEOMETRY, COLOR, LABEL, opt("background", "string", "background")],
  unknown: [ID, TYPE, ...GEOMETRY, COLOR],
  edge: [
    ID,
    req("fromNode", "string", "endpoints"),
    opt("fromSide", "side", "sides"),
    req("toNode", "string", "endpoints"),
    opt("toSide", "side", "sides"),
    opt("fromEnd", "end", "ends"),
    opt("toEnd", "end", "ends"),
    COLOR,
    LABEL,
  ],
};

const LEAD_KEYS: Record<CanvasNodeType | "edge", readonly string[]> = {
  text: ["id", "type", "text"],
  file: ["id", "type", "file", "subpath"],
  link: ["id", "type", "url"],
  group: ["id", "type", "backgroundStyle"],
  unknown: ["id", "type"],
  edge: ["id"],
};

const ALL_FIELDS = Object.values(FIELDS).flat();
const NULLABLE_KEYS = new Set(ALL_FIELDS.filter((spec) => !spec.required).map((spec) => spec.key));

export interface ConflictGroup {
  name: string;
  keys: readonly string[];
}

const CONFLICT_GROUPS = new Map<string, ConflictGroup>();
for (const { key, conflict } of ALL_FIELDS) {
  if (conflict === null || CONFLICT_GROUPS.has(key)) continue;
  const keys = [...new Set(ALL_FIELDS.filter((spec) => spec.conflict === conflict).map((spec) => spec.key))];
  CONFLICT_GROUPS.set(key, { name: conflict, keys });
}

const KNOWN_NODE_TYPES: readonly Exclude<CanvasNodeType, "unknown">[] = ["text", "file", "link", "group"];
const ENDS: readonly CanvasEnd[] = ["none", "arrow"];
const BACKGROUND_STYLES: readonly CanvasBackgroundStyle[] = ["cover", "ratio", "repeat"];

export function isSide(v: unknown): v is CanvasSide {
  return typeof v === "string" && (CANVAS_SIDES as readonly string[]).includes(v);
}

export function isEnd(v: unknown): v is CanvasEnd {
  return typeof v === "string" && (ENDS as readonly string[]).includes(v);
}

export function isBackgroundStyle(v: unknown): v is CanvasBackgroundStyle {
  return typeof v === "string" && (BACKGROUND_STYLES as readonly string[]).includes(v);
}

function isKnownNodeType(v: unknown): v is Exclude<CanvasNodeType, "unknown"> {
  return typeof v === "string" && (KNOWN_NODE_TYPES as readonly string[]).includes(v);
}

export function isValidField(spec: FieldSpec, v: unknown): boolean {
  switch (spec.kind) {
    case "string":
      return typeof v === "string";
    case "nonEmptyString":
      return typeof v === "string" && v !== "";
    case "subpath":
      return typeof v === "string" && v.startsWith("#");
    case "color":
      return typeof v === "string" && CANVAS_COLOR_RE.test(v);
    case "integer":
      return typeof v === "number" && Number.isFinite(v);
    case "side":
      return isSide(v);
    case "end":
      return isEnd(v);
    case "backgroundStyle":
      return isBackgroundStyle(v);
    default: {
      const exhaustive: never = spec.kind;
      return exhaustive;
    }
  }
}

export function coercedDefault(spec: FieldSpec): string | number {
  return spec.kind === "integer" ? 0 : "";
}

function kindOf(item: CanvasItem): ItemKind {
  return "type" in item ? "node" : "edge";
}

export function fieldsOf(item: CanvasItem): readonly FieldSpec[] {
  return "type" in item ? FIELDS[item.type] : FIELDS.edge;
}

export function specOf(fields: readonly FieldSpec[], key: string): FieldSpec | undefined {
  return fields.find((spec) => spec.key === key);
}

export function conflictGroupOf(key: string): ConflictGroup {
  return CONFLICT_GROUPS.get(key) ?? { name: key, keys: [key] };
}

export function hasOwn(obj: object | undefined, key: string): boolean {
  return obj !== undefined && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

export function getOwn(obj: object | undefined, key: string): unknown {
  if (!hasOwn(obj, key)) return undefined;
  return (obj as Raw)[key];
}

export function isPlainObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function uniqueKeys(keys: readonly string[]): string[] {
  return Array.from(new Set(keys));
}

function blankNode(type: CanvasNodeType, rawType: string): CanvasNode {
  const geometry = { x: 0, y: 0, width: 0, height: 0 };
  switch (type) {
    case "text":
      return { id: "", type, ...geometry, text: "" };
    case "file":
      return { id: "", type, ...geometry, file: "" };
    case "link":
      return { id: "", type, ...geometry, url: "" };
    case "group":
      return { id: "", type, ...geometry };
    case "unknown":
      return { id: "", type, rawType, ...geometry };
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function readKeys(raw: Raw, fields: readonly FieldSpec[]): { known: Raw; extra: Raw } {
  const known: Raw = {};
  const extra: Raw = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    const spec = specOf(fields, key);
    if (!spec || !isValidField(spec, value)) setOwn(extra, key, value);
    else if (spec !== TYPE) known[key] = value;
  }
  return { known, extra };
}

export function nodeFromRaw(raw: Raw, keyOrder: readonly string[] | undefined): CanvasNode {
  const rawType = getOwn(raw, "type");
  const type = isKnownNodeType(rawType) ? rawType : "unknown";
  const { known, extra } = readKeys(raw, FIELDS[type]);
  const node = blankNode(type, typeof rawType === "string" ? rawType : "");
  Object.assign(node, known);
  return finishItem(node, extra, keyOrder);
}

export function edgeFromRaw(raw: Raw, keyOrder: readonly string[] | undefined): CanvasEdge {
  const { known, extra } = readKeys(raw, FIELDS.edge);
  const edge: CanvasEdge = { id: "", fromNode: "", toNode: "" };
  Object.assign(edge, known);
  return finishItem(edge, extra, keyOrder);
}

function finishItem<T extends CanvasItem>(item: T, extra: Raw, keyOrder: readonly string[] | undefined): T {
  if (Object.keys(extra).length > 0) item.extra = extra;
  if (keyOrder) item.keyOrder = uniqueKeys(keyOrder);
  return item;
}

export type FieldState = "ok" | "missing" | "invalid";

export interface ResolvedField {
  state: FieldState;
  value: unknown;
  written: boolean;
}

export function resolveField(item: CanvasItem, spec: FieldSpec): ResolvedField {
  const { key } = spec;
  const typed = getOwn(item, key);
  const original = getOwn(item.extra, key);
  const placeholder = spec.required ? coercedDefault(spec) : undefined;
  const typedValid = typed !== undefined && isValidField(spec, typed);
  const isPlaceholder = typed === undefined || (spec.required && typed === placeholder);
  const absent: FieldState = spec.required ? "missing" : "ok";
  if (original !== undefined && (isPlaceholder || !typedValid)) {
    return { state: original === null ? absent : "invalid", value: original, written: true };
  }
  if (spec.required && isPlaceholder && item.keyOrder && !item.keyOrder.includes(key)) {
    return { state: "missing", value: typed, written: false };
  }
  if (!typedValid) return { state: typed === undefined ? absent : "invalid", value: placeholder, written: true };
  return { state: "ok", value: typed, written: true };
}

export function clearExtraKey(item: CanvasItem, key: string): void {
  if (!item.extra || !hasOwn(item.extra, key)) return;
  const next: Raw = {};
  for (const k of Object.keys(item.extra)) if (k !== key) setOwn(next, k, item.extra[k]);
  if (Object.keys(next).length > 0) item.extra = next;
  else delete item.extra;
}

function knownValue(item: CanvasItem, spec: FieldSpec, forWrite: boolean): unknown {
  const { state, value, written } = resolveField(item, spec);
  if (!forWrite) return value;
  if (!written) return undefined;
  return state === "ok" && spec.kind === "integer" && typeof value === "number" ? Math.round(value) : value;
}

function typeValue(item: CanvasItem): unknown {
  if (!("type" in item)) return undefined;
  if (item.type !== "unknown") return item.type;
  if (item.rawType !== "") return item.rawType;
  return getOwn(item.extra, "type");
}

function itemRecord(item: CanvasItem, forWrite = false): Raw {
  const fields = fieldsOf(item);
  const out: Raw = {};
  for (const spec of fields) {
    const value = spec === TYPE ? typeValue(item) : knownValue(item, spec, forWrite);
    if (value !== undefined) out[spec.key] = value;
  }
  if (item.extra) {
    for (const key of Object.keys(item.extra)) {
      if (specOf(fields, key)) continue;
      const value = item.extra[key];
      if (value !== undefined) setOwn(out, key, value);
    }
  }
  return out;
}

export function orderKeys(
  present: readonly string[],
  keyOrder: readonly string[] | undefined,
  defaults: readonly string[],
  lead: readonly string[] = [],
): string[] {
  const has = new Set(present);
  if (!keyOrder) {
    const out = defaults.filter((k) => has.has(k));
    const unknown = present.filter((k) => !out.includes(k));
    const after = Math.max(-1, ...lead.map((k) => out.indexOf(k)));
    out.splice(after + 1, 0, ...unknown);
    return out;
  }
  const out: string[] = [];
  for (const k of keyOrder) if (has.has(k) && !out.includes(k)) out.push(k);
  for (let d = 0; d < defaults.length; d++) {
    const key = defaults[d];
    if (key === undefined || !has.has(key) || out.includes(key)) continue;
    let pos = 0;
    for (let p = d - 1; p >= 0; p--) {
      const at = out.indexOf(defaults[p] ?? "");
      if (at >= 0) {
        pos = at + 1;
        break;
      }
    }
    out.splice(pos, 0, key);
  }
  for (const k of present) if (!out.includes(k)) out.push(k);
  return out;
}

export function itemEntries(item: CanvasItem, keyOrder: readonly string[] | undefined = item.keyOrder): Array<[string, unknown]> {
  const record = itemRecord(item, true);
  const defaults = fieldsOf(item).map((spec) => spec.key);
  const keys = orderKeys(Object.keys(record), keyOrder, defaults, LEAD_KEYS["type" in item ? item.type : "edge"]);
  return keys.map((k) => [k, record[k]]);
}

export function obsidianKeyOrder(item: CanvasItem): string[] {
  const keys = Object.keys(itemRecord(item, true));
  const defaults = fieldsOf(item).map((spec) => spec.key);
  const own = item.keyOrder ?? [];
  const idAt = own.indexOf("id");
  const first = idAt < 0 ? [] : own.slice(0, idAt).filter((k) => keys.includes(k) && !defaults.includes(k));
  return [...first, ...orderKeys(keys.filter((k) => !first.includes(k)), undefined, defaults, LEAD_KEYS["type" in item ? item.type : "edge"])];
}

export function isDefaultEnd(key: string, value: unknown): boolean {
  return (key === "toEnd" && value === "arrow") || (key === "fromEnd" && value === "none");
}

export function isNullableKnownKey(key: string): boolean {
  return NULLABLE_KEYS.has(key);
}

export function keyValueEqual(key: string, a: unknown, b: unknown): boolean {
  if (isNullableKnownKey(key)) {
    return deepEqual(a === null ? undefined : a, b === null ? undefined : b);
  }
  return deepEqual(a, b);
}

export function recordsEqual(a: Raw, b: Raw): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!keyValueEqual(key, getOwn(a, key), getOwn(b, key))) return false;
  return true;
}

export function itemsEquivalent(a: CanvasItem, b: CanvasItem): boolean {
  return recordsEqual(itemRecord(a), itemRecord(b));
}

function definedKeys(obj: Raw): string[] {
  return Object.keys(obj).filter((k) => obj[k] !== undefined);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ra = a as Raw;
  const rb = b as Raw;
  const ka = definedKeys(ra);
  const kb = definedKeys(rb);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!hasOwn(rb, k) || !deepEqual(ra[k], rb[k])) return false;
  return true;
}

export function originOf(text: string, node: Extract<JsonNode, { kind: "object" }>, line: number, index?: number): CanvasOrigin {
  const at = node.start;
  const entries = node.entries.map((e) => ({
    key: e.key,
    keyStart: e.keyStart - at,
    keyEnd: e.keyEnd - at,
    valueStart: e.value.start - at,
    valueEnd: e.value.end - at,
  }));
  return index === undefined ? { text, value: node.value, entries, line } : { text, value: node.value, entries, line, index };
}

export function itemFromOrigin(kind: ItemKind, origin: CanvasOrigin): CanvasItem {
  const keys = origin.entries.map((e) => e.key);
  return kind === "edge" ? edgeFromRaw(origin.value, keys) : nodeFromRaw(origin.value, keys);
}

export function isUnchanged(item: CanvasItem, origin: CanvasOrigin): boolean {
  return deepEqual(item, { ...itemFromOrigin(kindOf(item), origin), origin: item.origin });
}

export function withoutBookkeeping<T extends CanvasItem>(item: T): T {
  const copy = { ...item };
  delete copy.origin;
  delete copy.keyOrder;
  return copy;
}

export function canvasItemJson(item: CanvasItem): Raw {
  return itemRecord(item);
}

export function canvasItemFromJson(kind: "node", json: Raw, like?: CanvasNode): CanvasNode;
export function canvasItemFromJson(kind: "edge", json: Raw, like?: CanvasEdge): CanvasEdge;
export function canvasItemFromJson(kind: ItemKind, json: Raw, like?: CanvasItem): CanvasItem;
export function canvasItemFromJson(kind: ItemKind, json: Raw, like?: CanvasItem): CanvasItem {
  const built = kind === "edge" ? edgeFromRaw(json, like?.keyOrder) : nodeFromRaw(json, like?.keyOrder);
  if (like?.origin) built.origin = like.origin;
  return built;
}
