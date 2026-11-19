import type { GitLogEntry, GitPorts } from "./git-watch";

export interface FsView {
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;

  read(path: string): string | null;

  mtime(path: string): number | null;
}
export interface PathView {
  join(...parts: string[]): string;
  dirname(path: string): string;
  resolve(...parts: string[]): string;
}

export function findGitDir(start: string, fs: Pick<FsView, "isDirectory" | "isFile" | "read">, path: Pick<PathView, "join" | "dirname" | "resolve">): string | null {
  let dir = start;
  for (;;) {
    const dot = path.join(dir, ".git");
    if (fs.isDirectory(dot)) return dot;
    if (fs.isFile(dot)) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(fs.read(dot) ?? "")?.[1];
      const target = named === undefined ? null : path.resolve(dir, named);
      return target !== null && fs.isDirectory(target) ? target : null;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function reflogEntries(text: string | null): GitLogEntry[] {
  return (text ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [from = "", to = ""] = line.slice(0, tab < 0 ? undefined : tab).split(" ");
      return { from, to, message: line.slice(tab + 1) };
    });
}

export function gitPortsIn(gitDir: string, fs: Pick<FsView, "mtime" | "read">, path: Pick<PathView, "join">): GitPorts {
  const log = path.join(gitDir, "logs", "HEAD");
  const stash = path.join(gitDir, "logs", "refs", "stash");
  return { log: async () => fs.mtime(log), entries: async () => reflogEntries(fs.read(log)), stash: async () => fs.mtime(stash) };
}
