import type { App } from "obsidian";
import { FileSystemAdapter, Platform } from "obsidian";
import { findGitDir, gitPortsIn, reflogEntries, resolveHeadText } from "./git-dir";
import type { GitPorts } from "./git-watch";

export async function locateGit(app: App): Promise<GitPorts | null> {
  const { adapter } = app.vault;
  if (Platform.isDesktop && Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
    const load = (window as unknown as { require: (name: string) => unknown }).require;
    const fs = load("fs") as typeof import("node:fs");
    const path = load("path") as typeof import("node:path");
    const view = {
      isDirectory: (at: string): boolean => fs.statSync(at, { throwIfNoEntry: false })?.isDirectory() ?? false,
      isFile: (at: string): boolean => fs.statSync(at, { throwIfNoEntry: false })?.isFile() ?? false,
      read: (at: string): string | null => {
        try {
          return fs.readFileSync(at, "utf8");
        } catch {
          return null;
        }
      },
      mtime: (at: string): number | null => fs.statSync(at, { throwIfNoEntry: false })?.mtimeMs ?? null,
    };
    const gitDir = findGitDir(adapter.getBasePath(), view, path);
    return gitDir === null ? null : gitPortsIn(gitDir, view, path);
  }
  if (!(await adapter.exists(".git"))) return null;
  return {
    log: async () => (await adapter.stat(".git/logs/HEAD").catch(() => null))?.mtime ?? null,
    entries: async () => reflogEntries(await adapter.read(".git/logs/HEAD").catch(() => null)),
    stash: async () => (await adapter.stat(".git/logs/refs/stash").catch(() => null))?.mtime ?? null,
    head: async () =>
      resolveHeadText(
        await adapter.read(".git/HEAD").catch(() => null),
        (ref) => adapter.read(`.git/${ref}`).catch(() => null),
        () => adapter.read(".git/packed-refs").catch(() => null),
      ),
  };
}
