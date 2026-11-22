import { setOwn } from "./canvas-json";
import {
  canvasItemFromJson,
  canvasItemJson,
  conflictGroupOf,
  fieldsOf,
  getOwn,
  itemsEquivalent,
  keyValueEqual,
  recordsEqual,
  specOf,
  withoutBookkeeping,
  type CanvasItem,
  type ConflictGroup,
  type ItemKind,
  type Raw,
} from "./canvas-model";
import {
  CANVAS_CHANGE_FIELDS,
  CANVAS_CONFLICT_FIELDS,
  type CanvasChangeField,
  type CanvasConflict,
  type CanvasConflictChoice,
  type CanvasConflictField,
  type CanvasDiff,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasItemChange,
  type CanvasItemConflict,
  type CanvasMergeResult,
  type CanvasNode,
} from "./canvas-types";

interface Keyed<T> {
  key: string;
  item: T;
}

function keyed<T extends CanvasItem>(items: readonly T[]): Keyed<T>[] {
  const seen = new Map<string, number>();
  const out: Keyed<T>[] = [];
  for (const item of items) {
    const { id } = item;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    out.push({ key: n === 0 ? id : `${id}\u0000${n}`, item });
  }
  return out;
}

function toMap<T>(list: readonly Keyed<T>[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const { key, item } of list) map.set(key, item);
  return map;
}

function longestIncreasing(seq: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i] ?? 0;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] ?? 0] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] ?? -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = prev[i] ?? -1) keep.add(i);
  return keep;
}

export function reorderedIds(before: readonly string[], after: readonly string[]): Set<string> {
  const position = new Map<string, number>();
  before.forEach((id, i) => position.set(id, i));
  const common = after.filter((id) => position.has(id));
  const keep = longestIncreasing(common.map((id) => position.get(id) ?? 0));
  return new Set(common.filter((_, i) => !keep.has(i)));
}

function reorderedKeys<T>(before: readonly Keyed<T>[], after: readonly Keyed<T>[]): Set<string> {
  return reorderedIds(before.map(({ key }) => key), after.map(({ key }) => key));
}

function changedFields(a: CanvasItem, b: CanvasItem): Set<CanvasChangeField> {
  const ra = canvasItemJson(a);
  const rb = canvasItemJson(b);
  const fields = new Set<CanvasChangeField>();
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (key === "id" || keyValueEqual(key, getOwn(ra, key), getOwn(rb, key))) continue;
    fields.add(specOf(fieldsOf(a), key)?.change ?? specOf(fieldsOf(b), key)?.change ?? "extra");
  }
  return fields;
}

function sortFields(fields: Set<CanvasChangeField>): CanvasChangeField[] {
  return CANVAS_CHANGE_FIELDS.filter((f) => fields.has(f));
}

function diffItems<T extends CanvasItem>(base: readonly T[], head: readonly T[]): CanvasItemChange[] {
  const bk = keyed(base);
  const hk = keyed(head);
  const bMap = toMap(bk);
  const hMap = toMap(hk);
  const moved = reorderedKeys(bk, hk);
  const out: CanvasItemChange[] = [];
  for (const { key, item } of hk) {
    const before = bMap.get(key);
    if (!before) {
      out.push({ id: item.id, kind: "added", fields: [] });
      continue;
    }
    const fields = changedFields(before, item);
    if (moved.has(key)) fields.add("order");
    if (fields.size > 0) out.push({ id: item.id, kind: "changed", fields: sortFields(fields) });
  }
  for (const { key, item } of bk) {
    if (!hMap.has(key)) out.push({ id: item.id, kind: "removed", fields: [] });
  }
  return out;
}

export function diffCanvas(base: CanvasDoc, head: CanvasDoc): CanvasDiff {
  return {
    nodes: diffItems(base.nodes, head.nodes),
    edges: diffItems(base.edges, head.edges),
  };
}

function fieldGroups(records: readonly Raw[]): ConflictGroup[] {
  const groups: ConflictGroup[] = [];
  const done = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (key === "id" || done.has(key)) continue;
      const group = conflictGroupOf(key);
      groups.push(group);
      for (const k of group.keys) done.add(k);
    }
  }
  return groups;
}

function groupEqual(group: ConflictGroup, a: Raw, b: Raw): boolean {
  return group.keys.every((k) => keyValueEqual(k, getOwn(a, k), getOwn(b, k)));
}

function groupValue(group: ConflictGroup, record: Raw): unknown {
  if (group.keys.length === 1) return getOwn(record, group.keys[0] ?? "");
  const out: Raw = {};
  for (const k of group.keys) out[k] = getOwn(record, k);
  return out;
}

function copyGroup(group: ConflictGroup, from: Raw, into: Raw): void {
  for (const k of group.keys) {
    const v = getOwn(from, k);
    if (v === undefined) delete into[k];
    else setOwn(into, k, v);
  }
}

interface Sides<T> {
  ours: T;
  theirs: T;
}

interface MergeCtx {
  kind: ItemKind;
  conflicts: CanvasConflict[];
  choices: Record<string, CanvasConflictChoice>;
  needed?: Sides<ReadonlySet<string>>;
  cascaded?: Sides<ReadonlySet<string>>;
}

function itemConflict<T extends CanvasItem>(
  ctx: MergeCtx,
  id: string,
  reason: CanvasItemConflict["reason"],
  sides: { base: T | undefined; ours: T | undefined; theirs: T | undefined },
): void {
  const conflict = { key: `${ctx.kind}:${id}:*`, itemKind: ctx.kind, id, field: "*", reason, base: pub(sides.base), ours: pub(sides.ours), theirs: pub(sides.theirs) };
  ctx.conflicts.push(conflict as CanvasItemConflict);
}

function fieldConflict(ctx: MergeCtx, id: string, field: string, values: { base: unknown; ours: unknown; theirs: unknown }): void {
  ctx.conflicts.push({ key: `${ctx.kind}:${id}:${field}`, itemKind: ctx.kind, id, field, reason: "both_changed", ...values });
}

export function isCanvasItemConflict(c: CanvasConflict): c is CanvasItemConflict {
  return c.field === "*";
}

export function isCanvasConflictField(field: string): field is CanvasConflictField {
  return (CANVAS_CONFLICT_FIELDS as readonly string[]).includes(field);
}

const pub = <T extends CanvasItem>(item: T | undefined): T | null => (item ? withoutBookkeeping(item) : null);

const takesTheirs = (ctx: MergeCtx, id: string, field: string): boolean => getOwn(ctx.choices, `${ctx.kind}:${id}:${field}`) === "theirs";

function mergeOne<T extends CanvasItem>(ctx: MergeCtx, b: T | undefined, o: T | undefined, t: T | undefined): T | null {
  const id = (o ?? t ?? b)?.id ?? "";
  if (!b) {
    if (o && t) {
      if (itemsEquivalent(o, t)) return o;
      itemConflict(ctx, id, "both_changed", { base: undefined, ours: o, theirs: t });
      return takesTheirs(ctx, id, "*") ? t : o;
    }
    return o ?? t ?? null;
  }
  if (!o && !t) return null;
  if (!o) {
    if (t && itemsEquivalent(b, t) && !ctx.needed?.theirs.has(id)) return null;
    itemConflict(ctx, id, "deleted_vs_edited", { base: b, ours: undefined, theirs: t });
    return takesTheirs(ctx, id, "*") ? (t ?? null) : null;
  }
  if (!t) {
    if (itemsEquivalent(b, o) && !ctx.needed?.ours.has(id)) return null;
    itemConflict(ctx, id, "deleted_vs_edited", { base: b, ours: o, theirs: undefined });
    return takesTheirs(ctx, id, "*") ? null : o;
  }
  const rb = canvasItemJson(b);
  const ro = canvasItemJson(o);
  const rt = canvasItemJson(t);
  const merged: Raw = { ...ro };
  for (const group of fieldGroups([ro, rt, rb])) {
    if (groupEqual(group, ro, rb)) copyGroup(group, rt, merged);
    else if (groupEqual(group, rt, rb) || groupEqual(group, ro, rt)) continue;
    else {
      fieldConflict(ctx, id, group.name, { base: groupValue(group, rb), ours: groupValue(group, ro), theirs: groupValue(group, rt) });
      if (takesTheirs(ctx, id, group.name)) copyGroup(group, rt, merged);
    }
  }
  if (recordsEqual(merged, ro)) return o;
  if (recordsEqual(merged, rt)) return t;
  return canvasItemFromJson(ctx.kind, merged, o) as T;
}

function mergeItems<T extends CanvasItem>(
  ctx: MergeCtx,
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
): T[] {
  const bk = keyed(base);
  const ok = keyed(ours);
  const tk = keyed(theirs);
  const bMap = toMap(bk);
  const oMap = toMap(ok);
  const tMap = toMap(tk);
  const decided = new Map<string, T | null>();
  const allKeys = [...ok, ...tk, ...bk].map(({ key }) => key);
  for (const key of allKeys) {
    if (decided.has(key)) continue;
    const o = oMap.get(key) ?? (ctx.cascaded?.ours.has(key) ? tMap.get(key) : undefined);
    const t = tMap.get(key) ?? (ctx.cascaded?.theirs.has(key) ? oMap.get(key) : undefined);
    decided.set(key, mergeOne(ctx, bMap.get(key), o, t));
  }

  let seq = ok.map(({ key }) => key).filter((key) => decided.get(key));
  if (reorderedKeys(bk, ok).size === 0 && reorderedKeys(bk, tk).size > 0) {
    const common = new Set(seq.filter((key) => bMap.has(key) && tMap.has(key)));
    const theirsOrder = tk.map(({ key }) => key).filter((key) => common.has(key));
    let next = 0;
    seq = seq.map((key) => (common.has(key) ? (theirsOrder[next++] ?? key) : key));
  }
  const placed = new Set(seq);
  tk.forEach(({ key }, index) => {
    if (placed.has(key) || !decided.get(key)) return;
    let at = 0;
    for (let p = index - 1; p >= 0; p--) {
      const found = seq.indexOf(tk[p]?.key ?? "");
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    seq.splice(at, 0, key);
    placed.add(key);
  });
  const out: T[] = [];
  for (const key of seq) {
    const item = decided.get(key);
    if (item) out.push(item);
  }
  return out;
}

function mergeExtra(base: Raw | undefined, ours: Raw | undefined, theirs: Raw | undefined): Raw | undefined {
  const out: Raw = {};
  const keys = new Set([...Object.keys(ours ?? {}), ...Object.keys(theirs ?? {}), ...Object.keys(base ?? {})]);
  for (const key of keys) {
    const b = getOwn(base, key);
    const o = getOwn(ours, key);
    const t = getOwn(theirs, key);
    const pick = keyValueEqual(key, o, b) ? t : o;
    if (pick !== undefined) setOwn(out, key, pick);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pointedAt(base: readonly CanvasEdge[], side: readonly CanvasEdge[]): Set<string> {
  const before = toMap(keyed(base));
  const cards = new Set<string>();
  for (const { key, item } of keyed(side)) {
    const was = before.get(key);
    if (was && itemsEquivalent(was, item)) continue;
    cards.add(item.fromNode);
    cards.add(item.toNode);
  }
  return cards;
}

function droppedWithCard(base: readonly CanvasEdge[], side: CanvasDoc): Set<string> {
  const cards = new Set(side.nodes.map((n) => n.id));
  const kept = new Set(keyed(side.edges).map(({ key }) => key));
  const dropped = new Set<string>();
  for (const { key, item } of keyed(base)) {
    if (!kept.has(key) && !(cards.has(item.fromNode) && cards.has(item.toNode))) dropped.add(key);
  }
  return dropped;
}

export function mergeCanvas(
  base: CanvasDoc,
  ours: CanvasDoc,
  theirs: CanvasDoc,
  choices: Record<string, CanvasConflictChoice> = {},
): CanvasMergeResult {
  const conflicts: CanvasConflict[] = [];
  const needed = { ours: pointedAt(base.edges, ours.edges), theirs: pointedAt(base.edges, theirs.edges) };
  const nodes = mergeItems<CanvasNode>({ kind: "node", conflicts, choices, needed }, base.nodes, ours.nodes, theirs.nodes);
  const cascaded = { ours: droppedWithCard(base.edges, ours), theirs: droppedWithCard(base.edges, theirs) };
  const mergedEdges = mergeItems<CanvasEdge>({ kind: "edge", conflicts, choices, cascaded }, base.edges, ours.edges, theirs.edges);
  const kept = new Set(nodes.map((n) => n.id));
  const onASide = new Set([...ours.nodes, ...theirs.nodes].map((n) => n.id));
  const edges = mergedEdges.filter((e) => [e.fromNode, e.toNode].every((end) => kept.has(end) || !onASide.has(end)));

  const merged: CanvasDoc = { ...ours, nodes, edges };
  const extra = mergeExtra(base.extra, ours.extra, theirs.extra);
  if (extra) merged.extra = extra;
  else delete merged.extra;
  return { merged, conflicts, base, ours, theirs };
}

export function resolveCanvasMerge(result: CanvasMergeResult, choices: Record<string, CanvasConflictChoice>): CanvasDoc {
  return result.conflicts.length === 0 ? result.merged : mergeCanvas(result.base, result.ours, result.theirs, choices).merged;
}
