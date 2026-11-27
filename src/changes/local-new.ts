import { Platform, type Plugin, type TAbstractFile } from "obsidian";
import type { GroupsRead } from "../review/review-api";
import { watchWindows } from "../windows";
import {
  UNTITLED_PRE_TITLE_MAX_MS,
  cmContentElementOf,
  consumeBufferedBeforeInput,
  currentDoc,
  flushPreTitleOnFocus,
  flushPreTitleToEditor,
  flushRescuedChars,
  focusedInlineTitle,
  handlePreTitleBeforeInput,
  handlePreTitleKeyDown,
  inlineTitleElementOf,
  isBlockedPreTitleFocusTarget,
  isInlineTitleElement,
  isRescueTargetActive,
  isSyntheticTitleEnter,
  popLastCodePoint,
  settlePreTitleOnFileOpen,
  type PreTitleRescueState,
  type TitleRescueState,
} from "./title-rescue";
import type { VaultStates } from "./vault-state";

export { UNTITLED_PRE_TITLE_MAX_MS };

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
  isOwnWrite?(path: string): boolean;
  hasRepoFile?(path: string): boolean;
  hasForeignDraft?(path: string): boolean;
  hasUnagreedRemoteDraft?(path: string): boolean;
  noteLocalCreate?(path: string): void;
  noteLocalRename?(oldPath: string, newPath: string): void;
}

interface FreshEntry {
  path: string;
  place: string | null;
  opened?: boolean;
}

interface PluginLocalTracker {
  fresh: Map<string, FreshEntry>;
  locallyCreatedByLower: Map<string, FreshEntry>;
  model: LocalNewModel | null;
  listeners: Set<() => void>;
  createListeners: Set<(path: string) => void>;
  boundModel: boolean;
  lastUntitledCreateAt: number;
  lastArmedAt: number;
  quietUntil: number;
  postEnterUntil: number;
  quietTimer: number | null;
  focusedTitleEl: HTMLElement | null;
  titleFocusStartedAt: number;
  dismissedTitleEl: HTMLElement | null;
  rescue: TitleRescueState | null;
  preTitle: PreTitleRescueState | null;
  activePath: () => string | null;
}

const UNTITLED_NOTE = /(?:^|\/)Untitled(?: \d+)?\.(?:md|canvas|base)$/i;
const CANVAS_EXT = /\.canvas$/i;
const MAX_FRESH_LOCAL = 200;
const MAX_LOCALLY_CREATED = 500;
export const UNTITLED_QUIET_MS = 1_000;
export const UNTITLED_RENAME_QUIET_MS = 750;
export const UNTITLED_POST_ENTER_MS = 1_200;
export const UNTITLED_RESCUE_MAX_MS = 1_500;
export const UNTITLED_TITLE_MAX_MS = 2_500;
const UNTITLED_TITLE_POLL_MS = 120;
const utf8Encoder = new TextEncoder();

const repoLowerCache = new WeakMap<ReadonlyMap<string, string>, ReadonlySet<string>>();
const flightLowerCache = new WeakMap<object, { place: string; set: ReadonlySet<string> }>();
const stateLowerCache = new WeakMap<VaultStates, ReadonlyMap<string, readonly string[]>>();
const trackersByPlugin = new WeakMap<Plugin, PluginLocalTracker>();
const activeTrackers = new Set<PluginLocalTracker>();
const quietEndListeners = new Set<() => void>();

function notifyQuietEnd(): void {
  for (const listener of [...quietEndListeners]) listener();
}

function isFreshUntitledTitleFocused(tracker: PluginLocalTracker, now: number): boolean {
  const current = focusedInlineTitle();
  if (current === null || current === tracker.dismissedTitleEl) return false;
  if (tracker.focusedTitleEl === null) tracker.focusedTitleEl = current;
  const active = tracker.activePath();
  if (active !== null) return isUntitledPath(active) && tracker.fresh.has(active.toLowerCase());
  for (const entry of tracker.fresh.values()) {
    if (isUntitledPath(entry.path) && (tracker.lastUntitledCreateAt === 0 || now - tracker.lastUntitledCreateAt < UNTITLED_TITLE_MAX_MS)) return true;
  }
  return false;
}

export function onUntitledQuietEnd(listener: () => void): () => void {
  quietEndListeners.add(listener);
  return () => void quietEndListeners.delete(listener);
}

export function isUntitledPath(path: string): boolean {
  return UNTITLED_NOTE.test(path);
}

export const isUntitledNotePath = isUntitledPath;

export function isBlankUntitledContent(path: string, textOrSize: string | number): boolean {
  if (!UNTITLED_NOTE.test(path)) return false;
  const canvas = CANVAS_EXT.test(path);
  if (typeof textOrSize === "number") {
    if (!Number.isFinite(textOrSize) || textOrSize < 0) return false;
    return canvas ? textOrSize <= 32 : textOrSize === 0;
  }
  if (!canvas) return textOrSize.trim() === "";
  if (utf8Encoder.encode(textOrSize).byteLength > 32) return false;
  const compact = textOrSize.replace(/\s+/g, "");
  return compact === "" || compact === "{}" || compact === '{"nodes":[],"edges":[]}' || compact === '{"edges":[],"nodes":[]}';
}

function isEmptyUntitledFile(file: TAbstractFile): boolean {
  if (!file || typeof file.path !== "string" || "children" in file) return false;
  const size = (file as { stat?: { size?: number } }).stat?.size ?? 0;
  return isBlankUntitledContent(file.path, size);
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

function recordLocallyCreated(tracker: PluginLocalTracker, path: string): void {
  const lower = path.toLowerCase();
  tracker.locallyCreatedByLower.delete(lower);
  while (tracker.locallyCreatedByLower.size >= MAX_LOCALLY_CREATED) {
    const oldestKey = tracker.locallyCreatedByLower.keys().next().value;
    if (oldestKey === undefined) break;
    tracker.locallyCreatedByLower.delete(oldestKey);
  }
  const place = tracker.model ? tracker.model.placeNow() : null;
  tracker.locallyCreatedByLower.set(lower, { path, place });
}

function deleteLocallyCreated(tracker: PluginLocalTracker, path: string): void {
  tracker.locallyCreatedByLower.delete(path.toLowerCase());
}

function hasLocallyCreated(tracker: PluginLocalTracker, path: string): boolean {
  const entry = tracker.locallyCreatedByLower.get(path.toLowerCase());
  if (!entry) return false;
  if (tracker.model !== null && entry.place !== null && entry.place !== tracker.model.placeNow()) return false;
  return true;
}

function resetTrackerCreated(tracker: PluginLocalTracker): void {
  tracker.locallyCreatedByLower.clear();
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
  const workspace = plugin.app?.workspace;
  const tracker: PluginLocalTracker = {
    fresh: new Map(),
    locallyCreatedByLower: new Map(),
    model: null,
    listeners: new Set(),
    createListeners: new Set(),
    boundModel: false,
    lastUntitledCreateAt: 0,
    lastArmedAt: 0,
    quietUntil: 0,
    postEnterUntil: 0,
    quietTimer: null,
    focusedTitleEl: null,
    titleFocusStartedAt: 0,
    dismissedTitleEl: null,
    rescue: null,
    preTitle: null,
    activePath: () => (workspace && typeof workspace.getActiveFile === "function" ? (workspace.getActiveFile()?.path ?? null) : null),
  };
  trackersByPlugin.set(plugin, tracker);
  activeTrackers.add(tracker);
  let disposed = false;

  const clearQuietTimer = (): void => {
    if (tracker.quietTimer === null || typeof window === "undefined") return;
    window.clearTimeout(tracker.quietTimer);
    tracker.quietTimer = null;
  };

  const armQuietTimer = (): void => {
    if (disposed || typeof window === "undefined" || typeof window.setTimeout !== "function") return;
    clearQuietTimer();
    const wait = untitledCreateRemainingMs(plugin);
    if (wait <= 0) return;
    tracker.quietTimer = window.setTimeout(() => {
      tracker.quietTimer = null;
      if (disposed) return;
      const nextWait = untitledCreateRemainingMs(plugin);
      if (nextWait > 0) armQuietTimer();
      else notifyQuietEnd();
    }, wait);
  };

  const armCreateQuiet = (now: number): void => {
    tracker.lastUntitledCreateAt = now;
    tracker.lastArmedAt = now;
    tracker.quietUntil = Math.max(tracker.quietUntil, now + UNTITLED_QUIET_MS);
    tracker.dismissedTitleEl = null;
    armQuietTimer();
  };

  const seedPostEnter = (at: number): void => {
    tracker.lastArmedAt = at;
    tracker.postEnterUntil = Math.max(tracker.postEnterUntil, at + UNTITLED_POST_ENTER_MS);
    armQuietTimer();
  };

  const onFocusIn = (event: Event): void => {
    if (disposed) return;
    const now = Date.now();
    const titleEl = inlineTitleElementOf(event.target);
    if (titleEl !== null) {
      tracker.focusedTitleEl = titleEl;
      tracker.dismissedTitleEl = null;
      if (tracker.rescue && tracker.rescue.el !== titleEl) tracker.rescue = null;
      if (tracker.preTitle !== null) {
        flushPreTitleOnFocus(tracker, titleEl, now, UNTITLED_RESCUE_MAX_MS, () => disposed, isUntitledPath, seedPostEnter);
      }
      return;
    }
    const cmContent = cmContentElementOf(event.target);
    if (tracker.preTitle !== null) {
      if (cmContent !== null) {
        const pre = tracker.preTitle;
        const activeNow = tracker.activePath();
        const sameOrigin = cmContent === pre.originCmEl && (activeNow === pre.originPath || (activeNow !== null && !isUntitledPath(activeNow)));
        if (!sameOrigin) flushPreTitleToEditor(plugin, tracker, cmContent, now, () => disposed, isUntitledPath);
      } else if (isBlockedPreTitleFocusTarget(event.target)) {
        tracker.preTitle = null;
      }
    }
    if (tracker.rescue === null) return;
    if (now >= tracker.rescue.expiresAt) {
      tracker.rescue = null;
      return;
    }
    if (cmContent === null) {
      tracker.rescue = null;
      return;
    }
    const targetWin = cmContent.ownerDocument?.defaultView ?? null;
    if (tracker.rescue.win !== null && targetWin !== null && targetWin !== tracker.rescue.win) {
      tracker.rescue = null;
      return;
    }
    const cmLeaf = typeof cmContent.closest === "function" ? cmContent.closest(".workspace-leaf") : null;
    if (tracker.rescue.leafEl !== null && cmLeaf !== tracker.rescue.leafEl) {
      tracker.rescue = null;
      return;
    }
    const expectedPath = tracker.rescue.expectedPath;
    const activeNow = tracker.activePath();
    if (expectedPath !== null && (activeNow === null || activeNow.toLowerCase() !== expectedPath.toLowerCase())) {
      tracker.rescue = null;
      return;
    }
    const pending = tracker.rescue.pendingBodyChars;
    tracker.rescue = null;
    if (pending.length > 0) {
      queueMicrotask(() => {
        if (disposed) return;
        const activeAtFlush = tracker.activePath();
        if (expectedPath !== null && (activeAtFlush === null || activeAtFlush.toLowerCase() !== expectedPath.toLowerCase())) return;
        flushRescuedChars(plugin, cmContent, pending, expectedPath);
      });
    }
  };

  const onFocusOut = (event: Event): void => {
    if (disposed) return;
    const targetTitle = inlineTitleElementOf(event.target);
    if (targetTitle === null) return;
    if (tracker.focusedTitleEl !== null && targetTitle !== tracker.focusedTitleEl) return;
    if (isInlineTitleElement((event as FocusEvent).relatedTarget)) return;
    tracker.focusedTitleEl = null;
    tracker.titleFocusStartedAt = 0;
    tracker.dismissedTitleEl = targetTitle;
    if (untitledCreateRemainingMs(plugin) === 0) {
      clearQuietTimer();
      notifyQuietEnd();
    }
  };

  const onCaptureKeyDown = (event: Event): void => {
    if (disposed || isSyntheticTitleEnter(event)) return;
    const ke = event as KeyboardEvent;
    const now = Date.now();
    const key = typeof ke.key === "string" ? ke.key : "";
    const isMac = Boolean(Platform.isMacOS);
    const isModN = (isMac ? ke.metaKey && !ke.ctrlKey : ke.ctrlKey || ke.metaKey) && !ke.altKey && key.toLowerCase() === "n";
    if (isModN) {
      tracker.rescue = null;
      armCreateQuiet(now);
      const doc = (event.target as Node | null)?.ownerDocument ?? currentDoc();
      if (!ke.shiftKey && !ke.isComposing && !doc?.querySelector?.(".modal-container, .prompt")) {
        tracker.preTitle = {
          expiresAt: now + UNTITLED_PRE_TITLE_MAX_MS,
          win: doc?.defaultView ?? (typeof window !== "undefined" ? window : null),
          originTitleEl: focusedInlineTitle() ?? inlineTitleElementOf(doc?.activeElement ?? null) ?? inlineTitleElementOf(event.target),
          originCmEl: cmContentElementOf(doc?.activeElement ?? null) ?? cmContentElementOf(event.target),
          originPath: tracker.activePath(),
          pendingTitleChars: "",
          pendingBodyChars: "",
          submitted: false,
          skipBeforeInput: null,
        };
      } else {
        tracker.preTitle = null;
      }
      return;
    }
    if (tracker.preTitle !== null && handlePreTitleKeyDown(tracker, event, ke, key, now)) return;
    if (tracker.rescue && now >= tracker.rescue.expiresAt) {
      tracker.rescue = null;
      return;
    }
    if (!isRescueTargetActive(tracker.rescue, event.target, now)) return;
    if (key === "Escape") {
      tracker.rescue = null;
      return;
    }
    if (ke.ctrlKey || ke.metaKey || ke.altKey || ke.isComposing || key === "Process") return;
    if (key === "Enter" && !ke.shiftKey) {
      ke.preventDefault();
      ke.stopImmediatePropagation();
      tracker.rescue.pendingBodyChars += "\n";
      return;
    }
    if (key === "Backspace") {
      ke.preventDefault();
      tracker.rescue.pendingBodyChars = popLastCodePoint(tracker.rescue.pendingBodyChars);
      tracker.rescue.skipBeforeInput = { kind: "deleteContentBackward", at: now };
      return;
    }
    if (key.length === 1) {
      ke.preventDefault();
      tracker.rescue.pendingBodyChars += key;
      tracker.rescue.skipBeforeInput = { kind: "insertText", data: key, at: now };
    }
  };

  const onBeforeInput = (event: Event): void => {
    if (disposed) return;
    const now = Date.now();
    if (tracker.preTitle !== null && handlePreTitleBeforeInput(tracker, event, now)) return;
    if (tracker.rescue && now >= tracker.rescue.expiresAt) {
      tracker.rescue = null;
      return;
    }
    if (!isRescueTargetActive(tracker.rescue, event.target, now)) return;
    const rescue = tracker.rescue;
    consumeBufferedBeforeInput(
      rescue,
      event as InputEvent,
      now,
      true,
      (data) => {
        rescue.pendingBodyChars += data;
      },
      () => {
        rescue.pendingBodyChars = popLastCodePoint(rescue.pendingBodyChars);
      },
    );
  };

  const onPointerDown = (): void => {
    if (!disposed) {
      tracker.rescue = null;
      tracker.preTitle = null;
    }
  };

  const onBubbleKeyDown = (event: Event): void => {
    if (disposed) return;
    const ke = event as KeyboardEvent;
    if (ke.key !== "Enter" || ke.ctrlKey || ke.metaKey || ke.altKey || ke.shiftKey || ke.isComposing) return;
    const titleEl = inlineTitleElementOf(event.target);
    if (titleEl === null) return;
    const now = Date.now();
    tracker.lastArmedAt = now;
    tracker.postEnterUntil = Math.max(tracker.postEnterUntil, now + UNTITLED_POST_ENTER_MS);
    const doc = titleEl.ownerDocument ?? currentDoc();
    if (doc?.activeElement && !isInlineTitleElement(doc.activeElement)) {
      armQuietTimer();
      return;
    }
    const sameRescue = tracker.rescue && tracker.rescue.el === titleEl && now < tracker.rescue.expiresAt ? tracker.rescue : null;
    const leafEl = typeof titleEl.closest === "function" ? titleEl.closest(".workspace-leaf") : null;
    tracker.rescue = {
      el: titleEl,
      leafEl,
      expectedPath: sameRescue ? sameRescue.expectedPath : tracker.activePath(),
      win: titleEl.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null),
      pendingBodyChars: sameRescue ? sameRescue.pendingBodyChars : "",
      expiresAt: now + UNTITLED_RESCUE_MAX_MS,
      skipBeforeInput: null,
    };
    armQuietTimer();
  };

  const canWatchWindows =
    typeof window !== "undefined" &&
    workspace !== undefined &&
    typeof workspace.iterateAllLeaves === "function" &&
    typeof workspace.on === "function" &&
    typeof workspace.offref === "function" &&
    typeof plugin.register === "function";
  let stopDom: (() => void) | null = null;
  if (canWatchWindows) {
    stopDom = watchWindows(plugin, (win, on) => {
      if (!win.document || typeof win.document.addEventListener !== "function") return;
      on(win.document, "focusin", onFocusIn, { capture: true });
      on(win.document, "focusout", onFocusOut);
      on(win.document, "mousedown", onPointerDown, { capture: true });
      on(win.document, "keydown", onCaptureKeyDown, { capture: true });
      on(win.document, "beforeinput", onBeforeInput, { capture: true });
      on(win.document, "keydown", onBubbleKeyDown);
    });
  } else {
    const maybeDoc = currentDoc();
    const dom = maybeDoc && typeof maybeDoc.addEventListener === "function" ? maybeDoc : null;
    if (dom) {
      dom.addEventListener("focusin", onFocusIn, true);
      dom.addEventListener("focusout", onFocusOut);
      dom.addEventListener("mousedown", onPointerDown, true);
      dom.addEventListener("keydown", onCaptureKeyDown, true);
      dom.addEventListener("beforeinput", onBeforeInput, true);
      dom.addEventListener("keydown", onBubbleKeyDown);
      stopDom = () => {
        dom.removeEventListener("focusin", onFocusIn, true);
        dom.removeEventListener("focusout", onFocusOut);
        dom.removeEventListener("mousedown", onPointerDown, true);
        dom.removeEventListener("keydown", onCaptureKeyDown, true);
        dom.removeEventListener("beforeinput", onBeforeInput, true);
        dom.removeEventListener("keydown", onBubbleKeyDown);
      };
    }
  }
  if (typeof plugin.register === "function") {
    plugin.register(() => {
      disposed = true;
      clearQuietTimer();
      stopDom?.();
      stopDom = null;
      activeTrackers.delete(tracker);
      tracker.fresh.clear();
      resetTrackerCreated(tracker);
      tracker.listeners.clear();
      tracker.createListeners.clear();
      tracker.model = null;
      tracker.lastUntitledCreateAt = 0;
      tracker.lastArmedAt = 0;
      tracker.quietUntil = 0;
      tracker.postEnterUntil = 0;
      tracker.focusedTitleEl = null;
      tracker.titleFocusStartedAt = 0;
      tracker.dismissedTitleEl = null;
      tracker.rescue = null;
      tracker.preTitle = null;
    });
  }
  const vault = plugin.app?.vault;
  if (!vault || typeof vault.on !== "function") return;
  let ready = !(workspace && typeof workspace.onLayoutReady === "function");
  const keep = (ref: ReturnType<typeof vault.on>): void => {
    if (typeof plugin.registerEvent === "function") plugin.registerEvent(ref);
  };
  keep(
    vault.on("create", (file) => {
      if (disposed || !ready || !file || typeof file.path !== "string" || "children" in file) return;
      tracker.model?.noteLocalCreate?.(file.path);
      const blankUntitled = isEmptyUntitledFile(file);
      if (
        tracker.model?.isOwnWrite?.(file.path) !== true &&
        tracker.model?.hasRepoFile?.(file.path) !== true &&
        tracker.model?.hasForeignDraft?.(file.path) !== true &&
        (blankUntitled || tracker.model?.hasUnagreedRemoteDraft?.(file.path) !== true)
      ) {
        recordLocallyCreated(tracker, file.path);
      }
      if (!blankUntitled) return;
      tracker.titleFocusStartedAt = 0;
      armCreateQuiet(Date.now());
      recordFresh(tracker, file.path);
      if (CANVAS_EXT.test(file.path) && ((file as { stat?: { size?: number } }).stat?.size ?? 0) > 0 && typeof (vault as { read?: unknown }).read === "function") {
        void (vault as { read: (target: unknown) => Promise<string> })
          .read(file)
          .then((text) => {
            if (!disposed && typeof text === "string" && !isBlankUntitledContent(file.path, text)) tracker.fresh.delete(file.path.toLowerCase());
          })
          .catch(() => undefined);
      }
      for (const listener of tracker.createListeners) listener(file.path);
    }),
  );
  keep(
    vault.on("rename", (file, oldPath) => {
      if (disposed || typeof oldPath !== "string" || !file || typeof file.path !== "string" || "children" in file) return;
      tracker.model?.noteLocalRename?.(oldPath, file.path);
      if (tracker.rescue && tracker.rescue.expectedPath !== null && tracker.rescue.expectedPath.toLowerCase() === oldPath.toLowerCase()) {
        tracker.rescue.expectedPath = file.path;
      }
      const oldLower = oldPath.toLowerCase();
      const recorded = tracker.fresh.get(oldLower);
      const hadLocallyCreated = hasLocallyCreated(tracker, oldPath) || recorded !== undefined;
      deleteLocallyCreated(tracker, oldPath);
      if (
        hadLocallyCreated &&
        tracker.model?.isOwnWrite?.(file.path) !== true &&
        tracker.model?.hasRepoFile?.(file.path) !== true &&
        tracker.model?.hasForeignDraft?.(file.path) !== true &&
        tracker.model?.hasUnagreedRemoteDraft?.(file.path) !== true
      ) {
        recordLocallyCreated(tracker, file.path);
      }
      if (recorded === undefined) {
        if (hadLocallyCreated && isUntitledPath(oldPath)) {
          const now = Date.now();
          tracker.lastArmedAt = now;
          tracker.quietUntil = Math.max(tracker.quietUntil, now + UNTITLED_RENAME_QUIET_MS);
          armQuietTimer();
        }
        return;
      }
      const now = Date.now();
      tracker.titleFocusStartedAt = 0;
      tracker.dismissedTitleEl = tracker.focusedTitleEl;
      tracker.focusedTitleEl = null;
      tracker.lastUntitledCreateAt = now;
      tracker.lastArmedAt = now;
      tracker.quietUntil = Math.max(tracker.quietUntil, now + UNTITLED_RENAME_QUIET_MS);
      armQuietTimer();
      tracker.fresh.delete(oldLower);
      tracker.fresh.set(file.path.toLowerCase(), { path: file.path, place: recorded.place, opened: true });
    }),
  );
  keep(
    vault.on("delete", (file) => {
      if (!disposed && file && typeof file.path === "string") {
        if (tracker.rescue && tracker.rescue.expectedPath !== null && tracker.rescue.expectedPath.toLowerCase() === file.path.toLowerCase()) {
          tracker.rescue = null;
        }
        deleteLocallyCreated(tracker, file.path);
        if (tracker.fresh.delete(file.path.toLowerCase()) && tracker.fresh.size === 0) {
          tracker.titleFocusStartedAt = 0;
        }
      }
    }),
  );
  if (workspace && typeof workspace.on === "function") {
    const noteFreshOpen = (path: string | null): void => {
      if (disposed) return;
      if (tracker.rescue !== null) {
        const expected = tracker.rescue.expectedPath;
        if (expected === null || path === null || path.toLowerCase() !== expected.toLowerCase()) tracker.rescue = null;
      }
      if (path === null || !isUntitledPath(path)) return;
      const entry = tracker.fresh.get(path.toLowerCase());
      if (entry === undefined || entry.opened) return;
      entry.opened = true;
      armCreateQuiet(Date.now());
    };
    keep(
      workspace.on("file-open", (file) => {
        const opened = file?.path ?? tracker.activePath();
        noteFreshOpen(opened);
        settlePreTitleOnFileOpen(plugin, tracker, opened, Date.now(), UNTITLED_RESCUE_MAX_MS, () => disposed, isUntitledPath, seedPostEnter);
      }),
    );
    keep(workspace.on("active-leaf-change", () => noteFreshOpen(tracker.activePath())));
  }
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
  for (const entry of tracker.locallyCreatedByLower.values()) {
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
        for (const [, entry] of [...tracker.locallyCreatedByLower]) {
          if ((entry.place !== null && entry.place !== place) || model.hasRepoFile?.(entry.path) === true || model.hasForeignDraft?.(entry.path) === true) {
            deleteLocallyCreated(tracker, entry.path);
          }
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
  if (!isUntitledPath(path)) return false;
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
    if (isUntitledPath(entry.path) && match(entry.path)) tracker.fresh.delete(lower);
  }
}

export function isLocallyCreated(plugin: Plugin, path: string): boolean {
  const tracker = trackersByPlugin.get(plugin);
  return tracker ? hasLocallyCreated(tracker, path) : false;
}

export function forgetLocallyCreated(plugin: Plugin, path: string): void {
  const tracker = trackersByPlugin.get(plugin);
  if (tracker) deleteLocallyCreated(tracker, path);
}

export function resetLocallyCreated(plugin?: Plugin): void {
  if (plugin) {
    const tracker = trackersByPlugin.get(plugin);
    if (tracker) resetTrackerCreated(tracker);
    return;
  }
  for (const tracker of activeTrackers) resetTrackerCreated(tracker);
}

export function isPluginLocalOnlyNew(plugin: Plugin, path: string): boolean {
  const tracker = trackersByPlugin.get(plugin);
  if (!tracker) return false;
  if (tracker.model) return tracker.model.isLocalOnlyNew(path);
  return tracker.fresh.has(path.toLowerCase());
}

export function untitledCreateRemainingMs(plugin?: Plugin, now = Date.now()): number {
  const remainingOf = (tracker: PluginLocalTracker): number => {
    let wait = 0;
    if (tracker.quietUntil > now) wait = Math.max(wait, tracker.quietUntil - now);
    if (tracker.postEnterUntil > now) wait = Math.max(wait, tracker.postEnterUntil - now);
    if (isFreshUntitledTitleFocused(tracker, now)) {
      if (tracker.titleFocusStartedAt === 0 || now < tracker.titleFocusStartedAt) tracker.titleFocusStartedAt = now;
      const titleLeft = UNTITLED_TITLE_MAX_MS - (now - tracker.titleFocusStartedAt);
      if (titleLeft > 0) wait = Math.max(wait, Math.min(UNTITLED_TITLE_POLL_MS, titleLeft));
    } else {
      tracker.titleFocusStartedAt = 0;
    }
    return wait;
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

export const untitledQuietRemainingMs = untitledCreateRemainingMs;

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
  const stopQuiet = onUntitledQuietEnd(() => {
    if (disposed || scheduled?.kind !== "timeout") return;
    if (untitledCreateRemainingMs(plugin) > 0) return;
    window.clearTimeout(scheduled.id);
    scheduled = null;
    run();
  });
  if (typeof plugin.register === "function") {
    plugin.register(() => {
      disposed = true;
      stopQuiet();
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
  const stopQuiet = onUntitledQuietEnd(() => {
    if (!alive || timer === null) return;
    if (untitledCreateRemainingMs(plugin) > 0) return;
    clear();
    run();
  });
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
      stopQuiet();
      clear();
    },
  };
}

export function deferDuringUntitled(plugin: Plugin, run: () => void): () => void {
  const deferred = createUntitledDeferrer(plugin, run);
  if (typeof plugin.register === "function") plugin.register(deferred.dispose);
  return deferred.trigger;
}

export function repoLowerSet(repoFiles: ReadonlyMap<string, string>): ReadonlySet<string> {
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
  if (isUntitledPath(path) && fresh !== null) {
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
