import { type CanvasRect, sideToward } from "./canvas-sides";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const DEFAULT_ENDS: ReadonlyArray<readonly [key: string, value: string]> = [
  ["fromEnd", "none"],
  ["toEnd", "arrow"],
];

const isObject = (value: Json): value is { [key: string]: Json } => value !== null && typeof value === "object" && !Array.isArray(value);

const DRAWN = new Set<Json>(["file", "text", "link", "group"]);

const isRect = (node: Json): node is { [key: string]: Json } & { x: number; y: number; width: number; height: number } =>
  isObject(node) && DRAWN.has(node.type ?? null) && typeof node.x === "number" && typeof node.y === "number" && typeof node.width === "number" && typeof node.height === "number";

function asObsidianReadsIt(board: Json): Json {
  if (!isObject(board) || !Array.isArray(board.edges)) return board;
  const cards = new Map<Json, CanvasRect>();
  if (Array.isArray(board.nodes)) for (const node of board.nodes) if (isRect(node)) cards.set(node.id ?? null, node);
  const met = new Set<Json>();
  const edges = board.edges.map((edge) => {
    if (!isObject(edge)) return edge;
    const plain = { ...edge };
    for (const [key, value] of DEFAULT_ENDS) if (!plain[key] || plain[key] === value) delete plain[key];
    const first = !met.has(edge.id ?? null);
    met.add(edge.id ?? null);
    const [from, to] = [cards.get(edge.fromNode ?? null), cards.get(edge.toNode ?? null)];
    if (first && from && to) {
      const [fromSide, toSide] = [sideToward(from, to), sideToward(to, from)];
      if (!plain.fromSide && fromSide !== null) plain.fromSide = fromSide;
      if (!plain.toSide && toSide !== null) plain.toSide = toSide;
    }
    return plain;
  });
  return { ...board, edges };
}

function equalValues(first: Json, second: Json): boolean {
  const pairs: Array<[Json, Json]> = [[first, second]];
  for (let next = pairs.pop(); next !== undefined; next = pairs.pop()) {
    const [a, b] = next;
    if (a === b) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let at = 0; at < a.length; at++) pairs.push([a[at]!, b[at]!]);
      continue;
    }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      pairs.push([a[key]!, b[key]!]);
    }
  }
  return true;
}

function parse(text: string): { value: Json } | null {
  const bare = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { value: asObsidianReadsIt(bare === "" ? {} : (JSON.parse(bare) as Json)) };
  } catch {
    return null;
  }
}

export function sameCanvasText(a: string, b: string): boolean {
  const left = parse(a);
  const right = left && parse(b);
  return left !== null && right !== null && equalValues(left.value, right.value);
}
