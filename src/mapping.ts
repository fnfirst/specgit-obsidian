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

export function documentFor(settings: MappingSettings, vaultPath: string): DocumentRef | null {
  const place = placeOf(settings, vaultPath);
  return place.kind === "note" ? place.doc : null;
}

export function fileFor(settings: MappingSettings, vaultPath: string): DocumentRef | null {
  const place = placeOf(settings, vaultPath);
  return isRepoFile(place) ? place.doc : null;
}
