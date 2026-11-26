import type { Plugin, TAbstractFile } from "obsidian";
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

export interface LocalNewModel {
  isLocalOnlyNew(path: string): boolean;
  placeNow(): string;
  onLooked(listener: (looked: unknown) => void): () => void;
}

interface FreshEntry {
  path: string;
  place: string | null;
}

interface PluginLocalTracker {
  fresh: Map<string, FreshEntry>;
  model: LocalNewModel | null;
  listeners: Set<() => void>;
  createListeners: Set<(path: string) => void>;
  boundModel: boolean;
  lastUntitledCreateAt: number;
}

const UNTITLED_NOTE = /(?:^|\/)Untitled(?: \d+)?\.md$/i;
const MAX_FRESH_LOCAL = 200;
export const UNTITLED_QUIET_MS = 350;

const repoLowerCache = new WeakMap<ReadonlyMap<string, string>, ReadonlySet<string>>();
const flightLowerCache = new WeakMap<object, { place: string; set: ReadonlySet<string> }>();
const stateLowerCache = new WeakMap<VaultStates, ReadonlyMap<string, readonly string[]>>();
const trackersByPlugin = new WeakMap<Plugin, PluginLocalTracker>();
const activeTrackers = new Set<PluginLocalTracker>();

export function isUntitledNotePath(path: string): boolean {
  return UNTITLED_NOTE.test(path);
}

function isEmptyUntitledFile(file: TAbstractFile): boolean {
  if (!file || typeof file.path !== "string" || "children" in file) return false;
  if (!UNTITLED_NOTE.test(file.path)) return false;
  const size = (file as { stat?: { size?: number } }).stat?.size ?? 0;
  return size === 0;
}

function recordFresh(tracker: PluginLocalTracker, path: string): void {
  const lower = path.toLowerCase();
  const place = tracker.model ? tracker.model.placeNow() : null;
  tracker.fresh.delete(lower);
  if (tracker.fresh.size >= MAX_FRESH_LOCAL) {
    const oldest = tracker.fresh.keys().next().value;
    if (oldest !== undefined) tracker.fresh.delete(oldest);
  }
  tracker.fresh.set(lower, { path, place });
}

function trackedFreshEntry(lower: string, currentPlace: string): FreshEntry | null {
  for (const tracker of activeTrackers) {
    const recorded = tracker.fresh.get(lower);
    if (recorded !== undefined && (recorded.place === currentPlace || recorded.place === null)) return recorded;
  }
  return null;
}

export function trackFreshLocalNotes(plugin: Plugin): void {
  if (trackersByPlugin.has(plugin)) return;
  const tracker: PluginLocalTracker = {
    fresh: new Map(),
    model: null,
    listeners: new Set(),
    createListeners: new Set(),
    boundModel: false,
    lastUntitledCreateAt: 0,
  };
  trackersByPlugin.set(plugin, tracker);
  activeTrackers.add(tracker);
  let disposed = false;
  if (typeof plugin.register === "function") {
    plugin.register(() => {
      disposed = true;
      activeTrackers.delete(tracker);
      tracker.fresh.clear();
      tracker.listeners.clear();
      tracker.createListeners.clear();
      tracker.model = null;
      tracker.lastUntitledCreateAt = 0;
    });
  }
  const vault = plugin.app?.vault;
  if (!vault || typeof vault.on !== "function") return;
  const workspace = plugin.app?.workspace;
  let ready = !(workspace && typeof workspace.onLayoutReady === "function");
  const keep = (ref: ReturnType<typeof vault.on>): void => {
    if (typeof plugin.registerEvent === "function") plugin.registerEvent(ref);
  };
  keep(
    vault.on("create", (file) => {
      if (disposed || !ready || !isEmptyUntitledFile(file)) return;
      tracker.lastUntitledCreateAt = Date.now();
      recordFresh(tracker, file.path);
      for (const listener of tracker.createListeners) listener(file.path);
    }),
  );
  keep(
    vault.on("rename", (file, oldPath) => {
      if (disposed || typeof oldPath !== "string" || !file || typeof file.path !== "string") return;
      const oldLower = oldPath.toLowerCase();
      const recorded = tracker.fresh.get(oldLower);
      if (recorded === undefined) return;
      tracker.lastUntitledCreateAt = Date.now();
      tracker.fresh.delete(oldLower);
      tracker.fresh.set(file.path.toLowerCase(), { path: file.path, place: recorded.place });
    }),
  );
  keep(
    vault.on("delete", (file) => {
      if (!disposed && file && typeof file.path === "string") tracker.fresh.delete(file.path.toLowerCase());
    }),
  );
  if (workspace && typeof workspace.onLayoutReady === "function") {
    workspace.onLayoutReady(() => {
      if (!disposed) ready = true;
    });
  }
}

export function bindLocalNewModel(plugin: Plugin, model: LocalNewModel): void {
  trackFreshLocalNotes(plugin);
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return;
  tracker.model = model;
  const currentPlace = model.placeNow();
  for (const entry of tracker.fresh.values()) {
    if (entry.place === null) entry.place = currentPlace;
  }
  if (tracker.boundModel) return;
  tracker.boundModel = true;
  if (typeof model.onLooked === "function") {
    const stop = model.onLooked((looked) => {
      if (looked !== null) {
        const place = model.placeNow();
        for (const [lower, entry] of [...tracker.fresh]) {
          if ((entry.place !== null && entry.place !== place) || !model.isLocalOnlyNew(entry.path)) tracker.fresh.delete(lower);
        }
      }
      for (const listener of tracker.listeners) listener();
    });
    if (typeof plugin.register === "function") plugin.register(stop);
  }
}

export function onLocalNewUpdate(plugin: Plugin, listener: () => void): () => void {
  trackFreshLocalNotes(plugin);
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return () => undefined;
  tracker.listeners.add(listener);
  return () => void tracker.listeners.delete(listener);
}

export function onFreshUntitledCreate(plugin: Plugin, listener: (path: string) => void): () => void {
  trackFreshLocalNotes(plugin);
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return () => undefined;
  tracker.createListeners.add(listener);
  return () => void tracker.createListeners.delete(listener);
}

export function isFreshUntitled(plugin: Plugin, path: string): boolean {
  if (!isUntitledNotePath(path)) return false;
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return false;
  const recorded = tracker.fresh.get(path.toLowerCase());
  if (recorded === undefined) return false;
  if (tracker.model === null || recorded.place === null) return true;
  return recorded.place === tracker.model.placeNow();
}

export function forgetFreshUntitled(plugin: Plugin, path: string): void {
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return;
  tracker.fresh.delete(path.toLowerCase());
}

export function forgetFreshUntitledIf(plugin: Plugin, match: (path: string) => boolean): void {
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return;
  for (const [lower, entry] of [...tracker.fresh]) {
    if (isUntitledNotePath(entry.path) && match(entry.path)) tracker.fresh.delete(lower);
  }
}

export function isPluginLocalOnlyNew(plugin: Plugin, path: string): boolean {
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return false;
  if (tracker.model) return tracker.model.isLocalOnlyNew(path);
  return tracker.fresh.has(path.toLowerCase());
}

export function untitledCreateRemainingMs(plugin?: Plugin, now = Date.now()): number {
  const remainingOf = (tracker: PluginLocalTracker): number => {
    if (tracker.lastUntitledCreateAt === 0 || now < tracker.lastUntitledCreateAt) return 0;
    const elapsed = now - tracker.lastUntitledCreateAt;
    return elapsed >= UNTITLED_QUIET_MS ? 0 : UNTITLED_QUIET_MS - elapsed;
  };
  if (plugin) {
    const tracker = trackersByPlugin.get(plugin);
    return tracker ? remainingOf(tracker) : 0;
  }
  let max = 0;
  for (const tracker of activeTrackers) {
    const wait = remainingOf(tracker);
    if (wait > max) max = wait;
  }
  return max;
}

export function coalesceDuringUntitled(plugin: Plugin, run: () => void, mode: "raf" | "timeout" | "microtask" = "raf"): () => void {
  trackFreshLocalNotes(plugin);
  let scheduled: { kind: "raf" | "timeout" | "microtask"; id: number } | null = null;
  let disposed = false;
  const useRaf = mode === "raf" && typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
  const flush = (): void => {
    scheduled = null;
    if (disposed) return;
    const wait = untitledCreateRemainingMs(plugin);
    if (wait > 0) {
      scheduled = { kind: "timeout", id: window.setTimeout(flush, wait) };
      return;
    }
    run();
  };
  if (typeof plugin.register === "function") {
    plugin.register(() => {
      disposed = true;
      if (scheduled === null) return;
      if (scheduled.kind === "raf") window.cancelAnimationFrame(scheduled.id);
      else if (scheduled.kind === "timeout") window.clearTimeout(scheduled.id);
      scheduled = null;
    });
  }
  return (): void => {
    if (disposed || scheduled !== null) return;
    const wait = untitledCreateRemainingMs(plugin);
    if (wait > 0) {
      scheduled = { kind: "timeout", id: window.setTimeout(flush, wait) };
      return;
    }
    if (mode === "microtask") {
      scheduled = { kind: "microtask", id: 0 };
      queueMicrotask(flush);
      return;
    }
    scheduled = useRaf ? { kind: "raf", id: window.requestAnimationFrame(flush) } : { kind: "timeout", id: window.setTimeout(flush, 0) };
  };
}

export function createUntitledDeferrer(plugin: Plugin, run: () => void): { trigger: () => void; dispose: () => void } {
  trackFreshLocalNotes(plugin);
  let alive = true;
  let timer: number | null = null;
  const clear = (): void => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };
  const fire = (): void => {
    timer = null;
    if (!alive) return;
    const left = untitledCreateRemainingMs(plugin);
    if (left > 0) {
      timer = window.setTimeout(fire, left);
      return;
    }
    run();
  };
  return {
    trigger: (): void => {
      if (!alive) return;
      const wait = untitledCreateRemainingMs(plugin);
      if (wait === 0) {
        clear();
        run();
        return;
      }
      if (timer === null) timer = window.setTimeout(fire, wait);
    },
    dispose: (): void => {
      alive = false;
      clear();
    },
  };
}

export function deferDuringUntitled(plugin: Plugin, run: () => void): () => void {
  const deferred = createUntitledDeferrer(plugin, run);
  if (typeof plugin.register === "function") plugin.register(deferred.dispose);
  return deferred.trigger;
}

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
  if (place !== null && place !== currentPlace) return false;
  if (documentFor(path) === null) return false;
  const lower = path.toLowerCase();
  const cached = cache.get(path);
  const fresh = trackedFreshEntry(lower, currentPlace);
  if (isUntitledNotePath(path) && fresh !== null) {
    if (cached !== undefined && cached.sent !== undefined) return false;
    for (const [overPath, over] of overlay) if (overPath.toLowerCase() === lower && over.sha !== null) return false;
    return true;
  }
  if (deletedOnMain?.(path) === true) return false;
  if (cached !== undefined && (cached.base !== null || cached.sent !== undefined)) return false;
  if (repoFiles !== null && repoLowerSet(repoFiles).has(lower)) return false;
  for (const [overPath, over] of overlay) if (overPath.toLowerCase() === lower && over.sha !== null) return false;
  if (flight !== null && place !== null && flightLowerSet(flight, place, vaultPathFor).has(lower)) return false;
  if (states !== null) {
    for (const knownPath of stateLowerMap(states).get(lower) ?? []) {
      const file = states.files.get(knownPath)!;
      if (file.state.kind !== "here" || file.state.change !== "new") return false;
      const entry = cache.get(knownPath);
      if (entry !== undefined && (entry.base !== null || entry.sent !== undefined)) return false;
    }
  }
  if (place !== null && phase === "ready" && states !== null && repoFiles !== null && flight !== null) return true;
  return fresh !== null;
}
