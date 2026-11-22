export interface DocumentRef {
  repo: string;
  path: string;
}

export const docKey = (doc: DocumentRef): string => `${doc.repo}\0${doc.path}`;

export interface MappingSettings {
  repo: string;
  folder: string;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const isRepoName = (value: string): boolean => REPO.test(value);

export const normalizeFolder = (folder: string): string => folder.trim().replace(/^\/+|\/+$/g, "");

export const noteName = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

export const LISTED_FILE = /\.(md|canvas|base)$/i;

const KIND_OF: Record<string, "note" | "board" | "base"> = { md: "note", canvas: "board", base: "base" };

export type RepoFile = NoteFile | { kind: "board" | "base"; doc: DocumentRef };

export type NoteFile = { kind: "note"; doc: DocumentRef };

export type FileKind = "board" | "base" | "other";

export type PathKind = "note" | FileKind;

export type Place = RepoFile | { kind: "other" | "unlinked" } | { kind: "outside"; file: PathKind };

export const isRepoFile = (place: Place): place is RepoFile => "doc" in place;

export const pathKind = (vaultPath: string): PathKind => KIND_OF[LISTED_FILE.exec(vaultPath)?.[1]?.toLowerCase() ?? ""] ?? "other";

export function underFolder(folder: string, vaultPath: string): string | null {
  if (folder === "") return vaultPath;
  return vaultPath.startsWith(`${folder}/`) ? vaultPath.slice(folder.length + 1) : null;
}

export function placeOf(settings: MappingSettings, vaultPath: string): Place {
  if (!isRepoName(settings.repo)) return { kind: "unlinked" };
  const folder = normalizeFolder(settings.folder);
  const kind = pathKind(vaultPath);
  const path = underFolder(folder, vaultPath);
  if (path === null) return { kind: "outside", file: kind };
  return kind === "other" ? { kind: "other" } : { kind, doc: { repo: settings.repo, path } };
}

export const isHiddenPath = (path: string): boolean => path.split("/").some((part) => part.startsWith("."));

const UNSAFE_VAULT_CHARS = /[\\:\p{Cc}]/u;

export function normalizeConfigDir(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

export function isVaultTarget(path: string, configDir = ""): boolean {
  if (!path || path.startsWith("/") || UNSAFE_VAULT_CHARS.test(path)) return false;
  if (path.split("/").some((part) => part === "")) return false;
  if (isHiddenPath(path)) return false;
  const config = typeof configDir === "string" ? normalizeConfigDir(configDir) : "";
  if (config !== "") {
    const lowerPath = path.normalize("NFC").toLowerCase();
    const lowerConfig = config.toLowerCase();
    if (lowerPath === lowerConfig || lowerPath.startsWith(`${lowerConfig}/`)) return false;
  }
  return true;
}

export interface VaultPathEntry {
  path: string;
  folder?: boolean;
}

const caseSegKey = (segment: string): string => segment.normalize("NFC").toLowerCase();

export const casePathKey = (path: string): string => path.normalize("NFC").toLowerCase();

const isInPathChain = (candidate: string, target: string): boolean => candidate === target || target.startsWith(`${candidate}/`);

export function hasPathCaseCollision(entries: Iterable<VaultPathEntry>, target: string, excludeFrom?: string): boolean {
  if (!target || target === "/") return false;
  const tRaw = target.split("/");
  const tKey = tRaw.map(caseSegKey);
  const caseOnlySameFile = excludeFrom !== undefined && casePathKey(excludeFrom) === casePathKey(target);
  for (const entry of entries) {
    const p = entry.path;
    if (!p || p === "/") continue;
    const slash = p.indexOf("/");
    const first = slash === -1 ? p : p.slice(0, slash);
    if (caseSegKey(first) !== tKey[0]) continue;
    const pRaw = p.split("/");
    const limit = Math.min(pRaw.length, tRaw.length);
    for (let i = 0; i < limit; i++) {
      if (i > 0 && caseSegKey(pRaw[i]!) !== tKey[i]) break;
      if (i < tRaw.length - 1) {
        if (i === pRaw.length - 1 && entry.folder !== true) return true;
        if (pRaw[i] !== tRaw[i] && !(caseOnlySameFile && isInPathChain(p, excludeFrom))) return true;
      } else {
        if (pRaw.length > tRaw.length || entry.folder === true) return true;
        if (p !== target && p !== excludeFrom) return true;
      }
    }
  }
  return false;
}

export class CasePathIndex {
  private readonly files = new Map<string, Set<string>>();
  private readonly folders = new Map<string, Set<string>>();
  private readonly explicitFolders = new Set<string>();
  private readonly directChildren = new Map<string, Set<string>>();

  static from(entries: Iterable<VaultPathEntry>): CasePathIndex {
    const index = new CasePathIndex();
    for (const entry of entries) index.add(entry.path, entry.folder === true);
    return index;
  }

  static fromPaths(paths: Iterable<string>, extra?: Iterable<VaultPathEntry>): CasePathIndex {
    const index = new CasePathIndex();
    for (const path of paths) index.add(path, false);
    if (extra) for (const entry of extra) index.add(entry.path, entry.folder === true);
    return index;
  }

  add(path: string, folder = false): void {
    if (!path || path === "/") return;
    if (folder) this.explicitFolders.add(path);
    const bucket = folder ? this.folders : this.files;
    const key = casePathKey(path);
    let set = bucket.get(key);
    if (!set) {
      set = new Set();
      bucket.set(key, set);
    }
    set.add(path);
    let child = path;
    for (let slash = child.lastIndexOf("/"); slash > 0; slash = child.lastIndexOf("/")) {
      const parent = child.slice(0, slash);
      const parentKey = casePathKey(parent);
      let parents = this.folders.get(parentKey);
      if (!parents) {
        parents = new Set();
        this.folders.set(parentKey, parents);
      }
      parents.add(parent);
      let kids = this.directChildren.get(parent);
      if (!kids) {
        kids = new Set();
        this.directChildren.set(parent, kids);
      }
      kids.add(child);
      child = parent;
    }
  }

  removeFile(path: string, keepFolder?: (folder: string) => boolean): void {
    if (!path || path === "/") return;
    const key = casePathKey(path);
    const files = this.files.get(key);
    if (!files || !files.delete(path)) return;
    if (files.size === 0) this.files.delete(key);
    let child = path;
    for (let slash = child.lastIndexOf("/"); slash > 0; slash = child.lastIndexOf("/")) {
      const parent = child.slice(0, slash);
      const kids = this.directChildren.get(parent);
      if (kids) {
        kids.delete(child);
        if (kids.size === 0) this.directChildren.delete(parent);
      }
      if (this.directChildren.has(parent)) break;
      if (keepFolder ? keepFolder(parent) : this.explicitFolders.has(parent)) break;
      this.explicitFolders.delete(parent);
      const parentKey = casePathKey(parent);
      const parents = this.folders.get(parentKey);
      if (parents) {
        parents.delete(parent);
        if (parents.size === 0) this.folders.delete(parentKey);
      }
      child = parent;
    }
  }

  private onlyInChain(folder: string, from: string): boolean {
    let cur = folder;
    for (;;) {
      const kids = this.directChildren.get(cur);
      if (!kids) return true;
      let next: string | null = null;
      for (const child of kids) {
        if (!isInPathChain(child, from)) return false;
        if (child !== from) next = child;
      }
      if (next === null) return true;
      cur = next;
    }
  }

  collision(target: string, excludeFrom?: string): string | null {
    if (!target || target === "/") return null;
    const caseOnlySameFile = excludeFrom !== undefined && casePathKey(excludeFrom) === casePathKey(target);
    for (let slash = target.indexOf("/"); slash !== -1; slash = target.indexOf("/", slash + 1)) {
      const prefix = target.slice(0, slash);
      const key = casePathKey(prefix);
      const existingFiles = this.files.get(key);
      if (existingFiles && existingFiles.size > 0) return existingFiles.values().next().value!;
      const existingFolders = this.folders.get(key);
      if (existingFolders) {
        for (const existing of existingFolders) {
          if (existing === prefix) continue;
          if (caseOnlySameFile && excludeFrom.startsWith(`${existing}/`) && this.onlyInChain(existing, excludeFrom)) continue;
          return existing;
        }
      }
    }
    const key = casePathKey(target);
    const existingFolders = this.folders.get(key);
    if (existingFolders && existingFolders.size > 0) return existingFolders.values().next().value!;
    const existingFiles = this.files.get(key);
    if (existingFiles) {
      for (const existing of existingFiles) {
        if (existing === target || existing === excludeFrom) continue;
        return existing;
      }
    }
    return null;
  }
}

export function documentFor(settings: MappingSettings, vaultPath: string): DocumentRef | null {
  const place = placeOf(settings, vaultPath);
  return place.kind === "note" ? place.doc : null;
}

export function fileFor(settings: MappingSettings, vaultPath: string): DocumentRef | null {
  const place = placeOf(settings, vaultPath);
  return isRepoFile(place) ? place.doc : null;
}
