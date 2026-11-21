const BOM = "\uFEFF";

const DEFAULT_VIEW_NAMES: ReadonlySet<string> = new Set(["View", "Table"]);

const baseView = (raw: string): string => (raw.startsWith(BOM) ? raw.slice(1) : raw).replace(/\r\n?/g, "\n");

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

const hasOwn = (obj: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function setProp(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function canonicalPropertyId(value: string): string {
  if (value === "" || value.startsWith("note.") || value.startsWith("formula.") || value.startsWith("file.")) return value;
  return value === "file" ? "file.file" : `note.${value}`;
}

function normalizeSummaries(summaries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(summaries)) {
    const canonical = canonicalPropertyId(key);
    const value = summaries[key];
    if (hasOwn(out, canonical) && !equalValues(out[canonical], value)) return summaries;
    setProp(out, canonical, value);
  }
  return out;
}

function normalizeSortItem(item: unknown): unknown {
  if (!isPlainObject(item)) return item;
  const hasPropertyKey = hasOwn(item, "property");
  const hasStringProperty = hasPropertyKey && typeof item.property === "string";
  const legacyColumn = !hasPropertyKey && hasOwn(item, "column") && typeof item.column === "string";
  if (!hasStringProperty && !legacyColumn) return item;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(item)) {
    if (legacyColumn && key === "column") setProp(out, "property", canonicalPropertyId(item.column as string));
    else if (hasStringProperty && key === "property") setProp(out, "property", canonicalPropertyId(item.property as string));
    else setProp(out, key, item[key]);
  }
  return out;
}

function normalizeView(view: unknown): unknown {
  if (!isPlainObject(view)) return view;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(view)) {
    const value = view[key];
    if (key === "order" && Array.isArray(value)) {
      setProp(out, key, value.map((entry: unknown): unknown => (typeof entry === "string" ? canonicalPropertyId(entry) : entry)));
    } else if (key === "groupBy" && isPlainObject(value) && typeof value.property === "string") {
      const groupBy: Record<string, unknown> = {};
      for (const gk of Object.keys(value)) setProp(groupBy, gk, gk === "property" ? canonicalPropertyId(value.property) : value[gk]);
      setProp(out, key, groupBy);
    } else if (key === "sort" && Array.isArray(value)) {
      setProp(out, key, value.map(normalizeSortItem));
    } else if (key === "summaries" && isPlainObject(value)) {
      setProp(out, key, normalizeSummaries(value));
    } else {
      setProp(out, key, value);
    }
  }
  return out;
}

function normalizeProperties(props: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    const entry = props[key];
    if (entry === null || entry === undefined) continue;
    if (isPlainObject(entry) && Object.keys(entry).length === 0) continue;
    setProp(out, key, entry);
  }
  return Object.keys(out).length === 0 ? null : out;
}

function normalizeRoot(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (key === "views" && Array.isArray(entry)) {
      setProp(out, key, entry.map(normalizeView));
    } else if (key === "formulas" && isPlainObject(entry) && Object.keys(entry).length === 0) {
      continue;
    } else if (key === "properties" && isPlainObject(entry)) {
      const normalized = normalizeProperties(entry);
      if (normalized !== null) setProp(out, key, normalized);
    } else {
      setProp(out, key, entry);
    }
  }
  return out;
}

function isDefaultTableView(view: unknown): boolean {
  if (!isPlainObject(view)) return false;
  const keys = Object.keys(view);
  return keys.length === 2 && view.type === "table" && typeof view.name === "string" && DEFAULT_VIEW_NAMES.has(view.name);
}

const hasNoViews = (root: Record<string, unknown>): boolean => !hasOwn(root, "views") || (Array.isArray(root.views) && root.views.length === 0);

const isSingleDefaultTableView = (root: Record<string, unknown>): boolean => Array.isArray(root.views) && root.views.length === 1 && isDefaultTableView(root.views[0]);

function equalValues(first: unknown, second: unknown): boolean {
  const seen = new WeakMap<object, WeakSet<object>>();
  const pairs: Array<[unknown, unknown]> = [[first, second]];
  for (let next = pairs.pop(); next !== undefined; next = pairs.pop()) {
    const [a, b] = next;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    let against = seen.get(a);
    if (against?.has(b)) continue;
    if (!against) seen.set(a, (against = new WeakSet()));
    against.add(b);
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let at = 0; at < a.length; at++) pairs.push([a[at], b[at]]);
      continue;
    }
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!hasOwn(b, key)) return false;
      pairs.push([a[key], b[key]]);
    }
  }
  return true;
}

export type ParsedBase = { value: unknown } | null;

export function sameBaseData(a: unknown, b: unknown): boolean {
  const left = normalizeRoot(a);
  const right = normalizeRoot(b);
  if (left === null || right === null) return false;
  const leftKeys = Object.keys(left).filter((key) => key !== "views");
  const rightKeys = Object.keys(right).filter((key) => key !== "views");
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!hasOwn(right, key) || !equalValues(left[key], right[key])) return false;
  }
  if (hasNoViews(left) && hasNoViews(right)) return true;
  if ((hasNoViews(left) && isSingleDefaultTableView(right)) || (hasNoViews(right) && isSingleDefaultTableView(left))) return true;
  if (!hasOwn(left, "views") || !hasOwn(right, "views")) return false;
  return equalValues(left.views, right.views);
}

export function sameBaseTextWith(a: string, b: string, parse: (normalized: string) => ParsedBase): boolean {
  const leftText = baseView(a);
  const rightText = baseView(b);
  if (leftText === rightText) return true;
  const left = parse(leftText);
  const right = left === null ? null : parse(rightText);
  return left !== null && right !== null && sameBaseData(left.value, right.value);
}
