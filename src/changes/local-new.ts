import type { GroupsRead } from "../review/review-api";
import type { VaultStates } from "./vault-state";

export interface LocalNewInput {
  path: string;
  place: string | null;
  currentPlace: string;
  phase: string;
  states: VaultStates | null;
  repoFiles: ReadonlyMap<string, string> | null;
  flight: { paths: NonNullable<GroupsRead["paths"]> } | null;
  overlay: ReadonlyMap<string, { sha: string | null }>;
  cache: { get(path: string): { base: string | null; sent?: string } | undefined };
  documentFor: (path: string) => unknown;
  deletedOnMain?: (path: string) => boolean;
  vaultPathFor: (repoPath: string) => string;
}

const repoLowerCache = new WeakMap<ReadonlyMap<string, string>, ReadonlySet<string>>();
const flightLowerCache = new WeakMap<object, { place: string; set: ReadonlySet<string> }>();
const stateLowerCache = new WeakMap<VaultStates, ReadonlyMap<string, readonly string[]>>();

function repoLowerSet(repoFiles: ReadonlyMap<string, string>): ReadonlySet<string> {
  const cached = repoLowerCache.get(repoFiles);
  if (cached !== undefined) return cached;
  const set = new Set<string>();
  for (const repoPath of repoFiles.keys()) set.add(repoPath.toLowerCase());
  repoLowerCache.set(repoFiles, set);
  return set;
}

function flightLowerSet(flight: { paths: NonNullable<GroupsRead["paths"]> }, place: string, vaultPathFor: (repoPath: string) => string): ReadonlySet<string> {
  const cached = flightLowerCache.get(flight);
  if (cached !== undefined && cached.place === place) return cached.set;
  const set = new Set<string>();
  for (const [repoPath, entries] of Object.entries(flight.paths)) {
    if (entries.length > 0) set.add(vaultPathFor(repoPath).toLowerCase());
  }
  flightLowerCache.set(flight, { place, set });
  return set;
}

function stateLowerMap(states: VaultStates): ReadonlyMap<string, readonly string[]> {
  const cached = stateLowerCache.get(states);
  if (cached !== undefined) return cached;
  const map = new Map<string, string[]>();
  for (const knownPath of states.files.keys()) {
    const lower = knownPath.toLowerCase();
    const bucket = map.get(lower);
    if (bucket) bucket.push(knownPath);
    else map.set(lower, [knownPath]);
  }
  stateLowerCache.set(states, map);
  return map;
}

export function isLocalOnlyNew(input: LocalNewInput): boolean {
  const { path, place, currentPlace, phase, states, repoFiles, flight, overlay, cache, documentFor, deletedOnMain, vaultPathFor } = input;
  if (place === null || place !== currentPlace) return false;
  if (phase !== "ready" || states === null || repoFiles === null || flight === null) return false;
  if (documentFor(path) === null || deletedOnMain?.(path) === true) return false;
  const lower = path.toLowerCase();
  if (repoLowerSet(repoFiles).has(lower)) return false;
  for (const [overPath, over] of overlay) if (overPath.toLowerCase() === lower && over.sha !== null) return false;
  if (flightLowerSet(flight, place, vaultPathFor).has(lower)) return false;
  const cached = cache.get(path);
  if (cached !== undefined && (cached.base !== null || cached.sent !== undefined)) return false;
  for (const knownPath of stateLowerMap(states).get(lower) ?? []) {
    const file = states.files.get(knownPath)!;
    if (file.state.kind !== "here" || file.state.change !== "new") return false;
    const entry = cache.get(knownPath);
    if (entry !== undefined && (entry.base !== null || entry.sent !== undefined)) return false;
  }
  return true;
}
