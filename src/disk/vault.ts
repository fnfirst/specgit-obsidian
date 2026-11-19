import type { App, EventRef, TAbstractFile } from "obsidian";
import { BaseStore, type LocalState } from "./bases";

export interface VaultPort {

  read(path: string): Promise<string | null>;

  onModify(listener: (path: string) => void): () => void;

  onRename(listener: (from: string, to: string) => void): () => void;

  onDelete(listener: (path: string) => void): () => void;
}

export function obsidianVault(app: App): VaultPort {
  const { vault } = app;
  const listen = (subscribe: () => EventRef): (() => void) => {
    const ref = subscribe();
    return () => vault.offref(ref);
  };
  return {
    read: async (path) => {
      const file = vault.getFileByPath(path);
      return file ? vault.read(file) : null;
    },
    onModify: (listener) => listen(() => vault.on("modify", (file: TAbstractFile) => listener(file.path))),
    onRename: (listener) => listen(() => vault.on("rename", (file: TAbstractFile, from: string) => listener(from, file.path))),
    onDelete: (listener) => listen(() => vault.on("delete", (file: TAbstractFile) => listener(file.path))),
  };
}

export function diskPath(app: App): { vault: VaultPort; bases: BaseStore } {
  const state: LocalState = { load: (key): unknown => app.loadLocalStorage(key) as unknown, save: (key, value) => app.saveLocalStorage(key, value) };
  return { vault: obsidianVault(app), bases: new BaseStore(state) };
}
