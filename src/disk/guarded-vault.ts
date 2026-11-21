import { type App, TFile } from "obsidian";
import { gitBlobShaOfText } from "../changes/blob-sha";
import { toLf } from "./line-endings";

export interface GuardedVault {
  read(path: string): Promise<string | null>;
  hasUnsavedText(path: string): Promise<boolean>;
  process(path: string, edit: (current: string) => string | null): Promise<"written" | "refused" | "gone">;
  create(path: string, text: string): Promise<"created" | "exists" | "failed">;
  rename(from: string, to: string): Promise<"renamed" | "exists" | "gone" | "failed">;
  trash(path: string, expectedSha: string): Promise<boolean>;
  exists(path: string): boolean;
}

const DISPLAY_ONLY_VIEWS: ReadonlySet<string> = new Set(["backlink", "outgoing-link", "outline", "file-properties", "localgraph"]);

export function guardedVault(app: App): GuardedVault {
  const { vault, workspace, fileManager } = app;
  const heldInPane = (path: string, disk: string): boolean => {
    let held = false;
    workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { file?: { path: string } | null; editor?: { getValue(): string }; getViewType(): string };
      if (view.file?.path !== path) return;
      if (view.editor === undefined ? view.getViewType() !== "markdown" && !DISPLAY_ONLY_VIEWS.has(view.getViewType()) : view.editor.getValue() !== toLf(disk)) held = true;
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
    process: async (path, edit) => {
      const file = fileAt(path);
      if (!file) return "gone";
      let refused = false;
      try {
        await vault.process(file, (current) => {
          const next = heldInPane(path, current) ? null : edit(current);
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
