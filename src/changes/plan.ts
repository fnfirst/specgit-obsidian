import { comparedOf, type VaultFile, type VaultStates } from "./vault-state";

export type LocalChangeKind = "edited" | "new" | "renamed" | "deleted";

export interface LocalChange {
  kind: LocalChangeKind;
  path: string;
  from?: string;
  sha: string;
  repoSha: string | null;
  mainMoved: boolean;
  base: string | null;
  baseUnknown: boolean;
  onGitHub?: "deleted" | "moved";
}

export function changeOf(file: VaultFile): LocalChange | null {
  const state = comparedOf(file.state);
  const { path, sha, repoSha, base } = file;
  if (state === null || sha === null) return null;
  const added = (onGitHub?: "deleted" | "moved"): LocalChange => ({ kind: "new", path, sha, repoSha: null, mainMoved: false, baseUnknown: false, base: null, ...(onGitHub ? { onGitHub } : {}) });
  const changed = (kind: "edited" | "deleted", mainMoved: boolean): LocalChange => ({ kind, path, sha, repoSha, mainMoved, baseUnknown: base === null, base });
  switch (state.kind) {
    case "same":
    case "layout":
      return null;
    case "here":
      if (state.change === "new") return added();
      if (state.change === "renamed") return { kind: "renamed", path, from: state.from, sha, repoSha: null, mainMoved: false, baseUnknown: false, base: null };
      return changed(state.change, false);
    case "github":
      if (state.change === "deleted" || state.change === "moved") return added(state.change);
      return null;
    case "both":
      return state.github === "deleted" ? added("deleted") : changed(state.here, !state.baseUnknown);
  }
}

export const byName = (a: string, b: string): number => a.localeCompare(b);
export const byPath = (a: { path: string }, b: { path: string }): number => byName(a.path, b.path);

export function localChanges(vault: VaultStates): LocalChange[] {
  const edited: LocalChange[] = [];
  const added: LocalChange[] = [];
  const deleted: LocalChange[] = [];
  for (const file of vault.files.values()) {
    const change = changeOf(file);
    if (change) (change.kind === "edited" ? edited : change.kind === "deleted" ? deleted : added).push(change);
  }
  return [...edited, ...added, ...deleted].sort(byPath);
}
