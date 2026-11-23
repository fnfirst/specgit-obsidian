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

export async function resolveHeadText(
  raw: string | null,
  readRef: (ref: string) => Promise<string | null> | string | null,
  readPacked?: () => Promise<string | null> | string | null,
): Promise<string | null> {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("ref:")) return trimmed;
  const ref = trimmed.slice(4).trim();
  if (!ref || ref.includes("..") || ref.includes("\\") || ref.startsWith("/")) return trimmed;
  const loose = (await readRef(ref))?.trim();
  if (loose) return `${ref} -> ${loose}`;
  const packed = await readPacked?.();
  if (packed) {
    for (const line of packed.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" ");
      if (space > 0 && line.slice(space + 1).trim() === ref) return `${ref} -> ${line.slice(0, space)}`;
    }
  }
  return trimmed;
}

export function gitPortsIn(gitDir: string, fs: Pick<FsView, "mtime" | "read">, path: Pick<PathView, "join">): GitPorts {
  const log = path.join(gitDir, "logs", "HEAD");
  const stash = path.join(gitDir, "logs", "refs", "stash");
  const head = path.join(gitDir, "HEAD");
  const packed = path.join(gitDir, "packed-refs");
  return {
    log: async () => fs.mtime(log),
    entries: async () => reflogEntries(fs.read(log)),
    stash: async () => fs.mtime(stash),
    head: () => resolveHeadText(fs.read(head), (ref) => fs.read(path.join(gitDir, ...ref.split("/"))), () => fs.read(packed)),
  };
}
