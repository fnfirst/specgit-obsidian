import { type App, TFile } from "obsidian";
import { gitBlobShaOfText } from "../changes/blob-sha";
import { sameBaseText } from "../changes/same-base";
import { sameCanvasText } from "../shared/review-flow";
import { toLf } from "./line-endings";

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
}

const DISPLAY_ONLY_VIEWS: ReadonlySet<string> = new Set(["backlink", "outgoing-link", "outline", "file-properties", "localgraph"]);

interface PaneView {
  file?: { path: string } | null;
  editor?: { getValue(): string };
  getViewType(): string;
  getViewData?: () => string;
  canvas?: { isDragging?: boolean } | null;
  containerEl?: { querySelector?: (selector: string) => unknown } | null;
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
    const data = readViewData(view);
    if (data !== null && toLf(data) !== toLf(disk) && !sameCanvasText(data, disk)) return true;
    if (confirmed) return false;
    return data === null || view.canvas?.isDragging === true || view.containerEl?.querySelector?.(".canvas-node.is-editing") != null;
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
      if (vault.getAbstractFileByPath(path)) return "exists";
      try {
        await ensureFolder(path);
        await vault.create(path, text);
        return "created";
      } catch {
        return vault.getAbstractFileByPath(path) ? "exists" : "failed";
      }
    },
    rename: async (from, to) => {
      const file = fileAt(from);
      if (!file) return "gone";
      if (vault.getAbstractFileByPath(to)) return "exists";
      try {
        await ensureFolder(to);
        await vault.rename(file, to);
        return "renamed";
      } catch {
        return "failed";
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
  };
}

export function guardedBinaryCreate(app: App): (path: string, bytes: ArrayBuffer) => Promise<"created" | "exists" | "failed"> {
  const { vault } = app;
  return async (path, bytes) => {
    if (vault.getAbstractFileByPath(path)) return "exists";
    try {
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder !== "" && !vault.getFolderByPath(folder)) await vault.createFolder(folder).catch(() => undefined);
      await vault.createBinary(path, bytes);
      return "created";
    } catch {
      return vault.getAbstractFileByPath(path) ? "exists" : "failed";
    }
  };
}
