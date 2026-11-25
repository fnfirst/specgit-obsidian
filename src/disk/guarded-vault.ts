import { type App, TFile } from "obsidian";
import { gitBlobShaOfText } from "../changes/blob-sha";
import { sameBaseText } from "../changes/same-base";
import { hasPathCaseCollision, isVaultTarget, type VaultPathEntry } from "../mapping";
import { sameCanvasText } from "../shared/review-flow";
import type { OnWindow } from "../windows";
import { toLf } from "./line-endings";

const configDirOf = (app: App): string => (app.vault as { configDir?: string }).configDir ?? "";

type VaultIndex = {
  getAllLoadedFiles?: () => Array<{ path: string; children?: unknown }>;
  getFiles?: () => Array<{ path: string }>;
};

export function vaultLoadedEntries(vault: VaultIndex): VaultPathEntry[] {
  if (typeof vault.getAllLoadedFiles === "function") {
    return vault.getAllLoadedFiles().map((entry) => ({ path: entry.path, folder: Array.isArray(entry.children) }));
  }
  if (typeof vault.getFiles === "function") {
    return vault.getFiles().map((file) => ({ path: file.path, folder: false }));
  }
  return [];
}

export function hasVaultCaseCollision(vault: VaultIndex, target: string, excludeFrom?: string): boolean {
  return hasPathCaseCollision(vaultLoadedEntries(vault), target, excludeFrom);
}

export interface ProcessOptions {
  confirmed?: boolean;
}

export interface GuardedVault {
  read(path: string): Promise<string | null>;
  hasUnsavedText(path: string): Promise<boolean>;
  process(path: string, edit: (current: string) => string | null, options?: ProcessOptions): Promise<"written" | "refused" | "gone">;
  create(path: string, text: string): Promise<"created" | "exists" | "failed">;
  rename(from: string, to: string): Promise<"renamed" | "exists" | "gone" | "failed">;
  trash(path: string, expectedSha: string): Promise<boolean>;
  exists(path: string): boolean;
  collidesCase?(path: string, excludeFrom?: string): boolean;
  loadedEntries?(): readonly VaultPathEntry[];
}

const DISPLAY_ONLY_VIEWS: ReadonlySet<string> = new Set(["backlink", "outgoing-link", "outline", "file-properties", "localgraph"]);

interface CanvasNodeLike {
  text?: unknown;
  child?: {
    dirty?: unknown;
    editMode?: {
      cm?: {
        state?: {
          doc?: {
            toString?: () => string;
          };
        };
      };
    };
  } | null;
}

interface EditingElementLike {
  ownerDocument?: Document | null;
  contains?: (other: Node | null) => boolean;
}

interface PaneView {
  file?: { path: string } | null;
  editor?: { getValue(): string };
  getViewType(): string;
  getViewData?: () => string;
  canvas?: { isDragging?: boolean; nodes?: unknown } | null;
  containerEl?: {
    querySelector?: (selector: string) => unknown;
    querySelectorAll?: (selector: string) => Iterable<EditingElementLike>;
  } | null;
}

const idleCanvasEdits = new WeakSet<object>();
const clearTokens = new WeakMap<object, number>();
let hasIdleCanvasEdits = false;
let pendingCanvasFocusouts = 0;

function elementOf(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") return null;
  if ("closest" in target && typeof target.closest === "function") return target as Element;
  if ("parentElement" in target) {
    const parent = (target as Node).parentElement;
    return parent && typeof parent.closest === "function" ? parent : null;
  }
  return null;
}

function canvasNodeOf(target: EventTarget | null, selector: string): Element | null {
  let el = elementOf(target);
  while (el !== null) {
    const hit = el.closest(selector);
    if (hit !== null) return hit;
    const frame = el.ownerDocument?.defaultView?.frameElement ?? null;
    el = frame !== null && typeof frame.closest === "function" ? frame : null;
  }
  return null;
}

function isEditingKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key.length === 1 || event.key === "Backspace" || event.key === "Delete" || event.key === "Enter";
}

export function watchCanvasEditing(win: Window, on: OnWindow, onChange?: () => void, hasCanvas?: () => boolean): void {
  const clearNode = (target: EventTarget | null): void => {
    if ((!hasIdleCanvasEdits && pendingCanvasFocusouts === 0) || hasCanvas?.() === false) return;
    const node = canvasNodeOf(target, ".canvas-node");
    if (!node) return;
    idleCanvasEdits.delete(node);
    clearTokens.set(node, (clearTokens.get(node) ?? 0) + 1);
  };
  const activeInChildFrame = (editing: Element): boolean => {
    const doc = win.document;
    if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
    const active = doc.activeElement;
    return active !== null && active.tagName === "IFRAME" && editing.contains(active);
  };
  const staysFocusedInNode = (editing: Element): boolean => {
    const doc = win.document;
    if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
    const active = doc.activeElement;
    return active !== null && editing.contains(active);
  };
  on(win, "blur", () => {
    if (hasCanvas?.() !== false) {
      for (const editing of win.document.querySelectorAll(".canvas-node.is-editing")) {
        if (activeInChildFrame(editing)) continue;
        idleCanvasEdits.add(editing);
        hasIdleCanvasEdits = true;
      }
    }
    onChange?.();
  });
  on(win.document, "focusout", (event) => {
    const editing = hasCanvas?.() === false ? null : canvasNodeOf(event.target, ".canvas-node.is-editing");
    if (editing !== null) {
      const related = (event as FocusEvent).relatedTarget;
      const staysInside = related !== null && typeof related === "object" && "nodeType" in related && editing.contains(related as Node);
      if (!staysInside) {
        if (related === null) {
          const token = clearTokens.get(editing) ?? 0;
          pendingCanvasFocusouts++;
          win.setTimeout(() => {
            pendingCanvasFocusouts = Math.max(0, pendingCanvasFocusouts - 1);
            if ((clearTokens.get(editing) ?? 0) !== token) return;
            if (!editing.isConnected || !editing.classList.contains("is-editing")) return;
            if (staysFocusedInNode(editing)) return;
            idleCanvasEdits.add(editing);
            hasIdleCanvasEdits = true;
            onChange?.();
          }, 0);
          return;
        }
        idleCanvasEdits.add(editing);
        hasIdleCanvasEdits = true;
      }
    }
    onChange?.();
  });
  on(win, "pointerup", () => onChange?.());
  on(win, "keyup", (event) => {
    if ((event as KeyboardEvent).key === "Escape") onChange?.();
  });
  on(win, "mousedown", (event) => clearNode(event.target), { capture: true });
  on(win, "pointerdown", (event) => clearNode(event.target), { capture: true });
  on(win, "beforeinput", (event) => clearNode(event.target), { capture: true });
  on(win, "input", (event) => clearNode(event.target), { capture: true });
  on(win, "compositionstart", (event) => clearNode(event.target), { capture: true });
  on(win, "paste", (event) => clearNode(event.target), { capture: true });
  on(win, "cut", (event) => clearNode(event.target), { capture: true });
  on(
    win,
    "keydown",
    (event) => {
      if (isEditingKey(event as KeyboardEvent)) clearNode(event.target);
    },
    { capture: true },
  );
}

function canvasNodes(nodes: unknown): CanvasNodeLike[] {
  if (nodes instanceof Map) return [...nodes.values()] as CanvasNodeLike[];
  if (Array.isArray(nodes)) return nodes as CanvasNodeLike[];
  if (nodes !== null && typeof nodes === "object" && Symbol.iterator in nodes) {
    return [...(nodes as Iterable<unknown>)].map((entry): CanvasNodeLike => (Array.isArray(entry) && entry.length === 2 ? (entry as readonly unknown[])[1] : entry) as CanvasNodeLike);
  }
  return [];
}

function hasDirtyCanvasCard(view: PaneView): boolean {
  for (const node of canvasNodes(view.canvas?.nodes)) {
    const child = node?.child;
    if (!child) continue;
    if (child.dirty === true) return true;
    if (typeof node.text === "string") {
      const doc = child.editMode?.cm?.state?.doc;
      if (typeof doc?.toString === "function") {
        try {
          const live = doc.toString();
          if (typeof live === "string" && toLf(live) !== toLf(node.text)) return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}

function editingElements(containerEl: PaneView["containerEl"]): EditingElementLike[] {
  if (!containerEl) return [];
  if (typeof containerEl.querySelectorAll === "function") return [...containerEl.querySelectorAll(".canvas-node.is-editing")];
  const single = containerEl.querySelector?.(".canvas-node.is-editing");
  return single != null ? [single] : [];
}

function isEditingNodeActive(el: EditingElementLike): boolean {
  if (typeof el.contains !== "function" || el.ownerDocument === undefined) return true;
  if (idleCanvasEdits.has(el)) return false;
  const doc = el.ownerDocument;
  if (!doc) return false;
  if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
  return doc.activeElement !== null && el.contains(doc.activeElement);
}

function readViewData(view: PaneView): string | null {
  if (typeof view.getViewData !== "function") return null;
  try {
    const data = view.getViewData();
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

function viewHeld(view: PaneView, disk: string, confirmed: boolean): boolean {
  if (view.editor !== undefined) return view.editor.getValue() !== toLf(disk);
  const type = view.getViewType();
  if (type === "markdown" || DISPLAY_ONLY_VIEWS.has(type)) return false;
  if (type === "canvas") {
    if (hasDirtyCanvasCard(view)) return true;
    const data = readViewData(view);
    if (data !== null && toLf(data) !== toLf(disk) && !sameCanvasText(data, disk)) return true;
    if (confirmed) return false;
    return data === null || view.canvas?.isDragging === true || editingElements(view.containerEl).some(isEditingNodeActive);
  }
  if (type === "bases") {
    const data = readViewData(view);
    if (data !== null && toLf(data) !== toLf(disk) && !sameBaseText(data, disk)) return true;
    return !confirmed && data === null;
  }
  return !confirmed;
}

export function guardedVault(app: App): GuardedVault {
  const { vault, workspace, fileManager } = app;
  const heldInPane = (path: string, disk: string, confirmed = false): boolean => {
    let held = false;
    workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as PaneView;
      if (view.file?.path !== path) return;
      if (viewHeld(view, disk, confirmed)) held = true;
    });
    return held;
  };
  const fileAt = (path: string): TFile | null => {
    const file = vault.getFileByPath(path);
    return file instanceof TFile ? file : null;
  };
  const ensureFolder = async (path: string): Promise<void> => {
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder === "" || vault.getFolderByPath(folder)) return;
    await vault.createFolder(folder).catch(() => undefined);
  };
  return {
    read: async (path) => {
      const file = fileAt(path);
      return file ? vault.read(file).catch(() => null) : null;
    },
    hasUnsavedText: async (path) => {
      const file = fileAt(path);
      const disk = file ? await vault.read(file).catch(() => null) : null;
      return disk !== null && heldInPane(path, disk);
    },
    process: async (path, edit, options) => {
      const file = fileAt(path);
      if (!file) return "gone";
      let refused = false;
      const confirmed = options?.confirmed === true;
      try {
        await vault.process(file, (current) => {
          const next = heldInPane(path, current, confirmed) ? null : edit(current);
          if (next === null) {
            refused = true;
            return current;
          }
          return next;
        });
      } catch {
        return vault.getFileByPath(path) ? "refused" : "gone";
      }
      return refused ? "refused" : "written";
    },
    create: async (path, text) => {
      if (!isVaultTarget(path, configDirOf(app))) return "failed";
      if (vault.getAbstractFileByPath(path) || hasVaultCaseCollision(vault, path)) return "exists";
      try {
        await ensureFolder(path);
        await vault.create(path, text);
        return "created";
      } catch {
        return vault.getAbstractFileByPath(path) || hasVaultCaseCollision(vault, path) ? "exists" : "failed";
      }
    },
    rename: async (from, to) => {
      if (!isVaultTarget(to, configDirOf(app))) return "failed";
      const file = fileAt(from);
      if (!file) return "gone";
      if (vault.getAbstractFileByPath(to) || hasVaultCaseCollision(vault, to, from)) return "exists";
      try {
        await ensureFolder(to);
        await vault.rename(file, to);
        return "renamed";
      } catch {
        return vault.getAbstractFileByPath(to) || hasVaultCaseCollision(vault, to, from) ? "exists" : "failed";
      }
    },
    trash: async (path, expectedSha) => {
      const file = fileAt(path);
      const current = file ? await vault.read(file).catch(() => null) : null;
      if (!file || current === null || gitBlobShaOfText(current) !== expectedSha || heldInPane(path, current)) return false;
      try {
        await fileManager.trashFile(file);
        return true;
      } catch {
        return false;
      }
    },
    exists: (path) => vault.getAbstractFileByPath(path) !== null,
    collidesCase: (path, excludeFrom) => hasVaultCaseCollision(vault, path, excludeFrom),
    loadedEntries: () => vaultLoadedEntries(vault),
  };
}

export function guardedBinaryCreate(app: App): (path: string, bytes: ArrayBuffer) => Promise<"created" | "exists" | "failed"> {
  const { vault } = app;
  return async (path, bytes) => {
    if (!isVaultTarget(path, configDirOf(app))) return "failed";
    if (vault.getAbstractFileByPath(path) || hasVaultCaseCollision(vault, path)) return "exists";
    try {
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder !== "" && !vault.getFolderByPath(folder)) await vault.createFolder(folder).catch(() => undefined);
      await vault.createBinary(path, bytes);
      return "created";
    } catch {
      return vault.getAbstractFileByPath(path) || hasVaultCaseCollision(vault, path) ? "exists" : "failed";
    }
  };
}
