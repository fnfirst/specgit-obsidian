import { underFolder } from "../mapping";
import { byName } from "./plan";
import type { CacheEntry, Gone } from "./cache";
import { type MissingNotes, missingNotes } from "./missing-notes";
import { unchangedHere } from "./unchanged-here";

export interface TheirReview {

  by: string;
  branch: string;

  prNumber: number | null;
  prUrl: string | null;

  draft: boolean;
}

export type Compared =
  | { kind: "same" }
  | { kind: "layout" }
  | { kind: "here"; change: "edited" | "new" | "deleted" }
  | { kind: "here"; change: "renamed"; from: string }
  | { kind: "github"; change: "updated" | "new" | "deleted" }
  | { kind: "github"; change: "moved"; to: string }
  | { kind: "both"; here: "edited"; github: "edited" | "deleted"; baseUnknown: boolean }
  | { kind: "both"; here: "deleted"; github: "edited"; baseUnknown: boolean };

export type LeftOut = { kind: "leftOut"; why: "foreign" | "sameName" | "chosen" };

export type VaultState = Compared | { kind: "live"; file: Compared } | { kind: "theirs"; review: TheirReview; file: Compared } | LeftOut;

type Held = Pick<CacheEntry, "sha" | "base" | "same">;

interface OnBoth {
  vault: Held;

  repoSha: string;

  foreign?: string;
}

interface OnlyHere {
  vault: Held;
  repoSha: null;
  foreign?: string;

  renamedFrom?: string;

  movedTo?: string;

  keptFromMain?: boolean;
}

interface OnlyOnGitHub {
  vault?: undefined;
  repoSha: string;

  gone?: Gone;

  nameTaken?: boolean;
}

export type FileFacts = (OnBoth | OnlyHere | OnlyOnGitHub) & {

  theirs?: TheirReview;

  live?: boolean;

  leftOut?: boolean;
};

function onBoth({ vault, repoSha, foreign }: OnBoth): Compared | LeftOut {
  if (vault.sha === repoSha) return { kind: "same" };

  if (vault.base === null && foreign === vault.sha) return { kind: "leftOut", why: "foreign" };
  if (vault.same === repoSha) return { kind: "layout" };
  if (vault.base === null) return { kind: "both", here: "edited", github: "edited", baseUnknown: true };

  if (unchangedHere(vault)) return { kind: "github", change: "updated" };
  return vault.base === repoSha ? { kind: "here", change: "edited" } : { kind: "both", here: "edited", github: "edited", baseUnknown: false };
}

function onlyHere({ vault, foreign, renamedFrom, movedTo, keptFromMain }: OnlyHere): Compared | LeftOut {
  if (foreign === vault.sha) return { kind: "leftOut", why: "foreign" };
  if (renamedFrom !== undefined) return { kind: "here", change: "renamed", from: renamedFrom };

  if (vault.base === null) return keptFromMain ? { kind: "both", here: "edited", github: "deleted", baseUnknown: true } : { kind: "here", change: "new" };

  if (!unchangedHere(vault)) return { kind: "both", here: "edited", github: "deleted", baseUnknown: false };
  return movedTo !== undefined ? { kind: "github", change: "moved", to: movedTo } : { kind: "github", change: "deleted" };
}

function onlyOnGitHub({ repoSha, gone, nameTaken }: OnlyOnGitHub): Compared | LeftOut {
  if (!gone) return nameTaken ? { kind: "leftOut", why: "sameName" } : { kind: "github", change: "new" };

  if (gone.base === null ? gone.sha === repoSha : gone.base === repoSha) return { kind: "here", change: "deleted" };
  return { kind: "both", here: "deleted", github: "edited", baseUnknown: gone.base === null };
}

function compare(facts: OnBoth | OnlyHere | OnlyOnGitHub): Compared | LeftOut {
  if (!facts.vault) return onlyOnGitHub(facts);
  return facts.repoSha === null ? onlyHere(facts) : onBoth(facts);
}

export function fileState(facts: FileFacts): VaultState {
  if (facts.leftOut) return { kind: "leftOut", why: "chosen" };
  const file = compare(facts);
  if (file.kind === "leftOut") return file;
  if (facts.live) return { kind: "live", file };
  return facts.theirs ? { kind: "theirs", review: facts.theirs, file } : file;
}

export function comparedOf(state: VaultState): Compared | null {
  if (state.kind === "leftOut") return null;
  return state.kind === "live" || state.kind === "theirs" ? state.file : state;
}

export interface VaultFile {

  path: string;
  state: VaultState;

  sha: string | null;

  repoSha: string | null;

  base: string | null;

  added?: boolean;
}

export function rebasedOnto(file: VaultFile, sha: string): VaultFile {
  const under = comparedOf(file.state);
  const onBothSides = under?.kind === "both" && under.here === "edited" && under.github === "edited";
  const hereAlready = under?.kind === "here" && under.change === "edited";
  if (!onBothSides && !(hereAlready && file.base !== sha)) return file;
  const edited: Compared = { kind: "here", change: "edited" };
  return { ...file, base: sha, state: file.state.kind === "live" || file.state.kind === "theirs" ? { ...file.state, file: edited } : edited };
}

export interface LookFacts {
  files: ReadonlyMap<string, CacheEntry>;

  repo: ReadonlyMap<string, string>;
  deleted: readonly Gone[];
  foreign?: ReadonlyMap<string, string>;
  keptFromMain?: (path: string) => boolean;

  added?: ReadonlySet<string>;

  theirs?: ReadonlyMap<string, TheirReview>;
  live?: (path: string) => boolean;
  leftOut?: (path: string) => boolean;
}

export interface VaultStates {

  files: ReadonlyMap<string, VaultFile>;

  missing: MissingNotes;
}

class Unpaired<T> {
  private readonly bySha = new Map<string, { items: T[]; next: number }>();

  add(sha: string, item: T): void {
    const held = this.bySha.get(sha);
    if (held) held.items.push(item);
    else this.bySha.set(sha, { items: [item], next: 0 });
  }

  peek(sha: string): T | undefined {
    const held = this.bySha.get(sha);
    return held?.items[held.next];
  }

  take(sha: string): void {
    const held = this.bySha.get(sha);
    if (held) held.next++;
  }
}

export function vaultStates(looked: LookFacts): VaultStates {
  const { files, repo, deleted } = looked;
  const found = new Map<string, VaultFile>();
  const stateOf = (path: string, facts: OnBoth | OnlyHere | OnlyOnGitHub): VaultState => fileState({ ...facts, theirs: looked.theirs?.get(path), live: looked.live?.(path), leftOut: looked.leftOut?.(path) });

  const lost = new Map<string, Gone>();
  const sources = new Unpaired<string>();
  for (const gone of deleted) {
    if (files.has(gone.path) || !repo.has(gone.path) || lost.has(gone.path)) continue;
    lost.set(gone.path, gone);
    if (repo.get(gone.path) === gone.sha) sources.add(gone.sha, gone.path);
  }

  const arrivals = new Unpaired<string>();
  for (const [path, sha] of repo) if (!files.has(path) && !lost.has(path)) arrivals.add(sha, path);
  const renamedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const [path, vault] of files) {
    const repoSha = repo.get(path);
    const foreign = looked.foreign?.get(path);
    const state = stateOf(path, repoSha !== undefined ? { vault, repoSha, foreign } : { vault, repoSha: null, foreign, renamedFrom: sources.peek(vault.sha), movedTo: arrivals.peek(vault.sha), keptFromMain: looked.keptFromMain?.(path) });
    const file = comparedOf(state);
    if (file?.kind === "here" && file.change === "renamed") {
      sources.take(vault.sha);
      renamedFrom.add(file.from);
    } else if (file?.kind === "github" && file.change === "moved") {
      arrivals.take(vault.sha);
      movedTo.add(file.to);
    }
    found.set(path, { path, state, sha: vault.sha, repoSha: repoSha ?? null, base: vault.base });
  }
  for (const gone of lost.values()) {
    if (renamedFrom.has(gone.path)) continue;
    const repoSha = repo.get(gone.path)!;
    found.set(gone.path, { path: gone.path, state: stateOf(gone.path, { gone, repoSha }), sha: gone.sha, repoSha, base: gone.base });
  }

  const missing = missingNotes(repo.keys(), files.keys(), deleted.map((gone) => gone.path));
  const onGitHub = (path: string, nameTaken: boolean): void => {
    if (movedTo.has(path)) return;
    const repoSha = repo.get(path)!;
    found.set(path, { path, state: stateOf(path, { repoSha, nameTaken }), sha: null, repoSha, base: null, added: looked.added?.has(path) === true });
  };
  for (const path of missing.copy) onGitHub(path, false);
  for (const path of missing.skipped) onGitHub(path, true);
  return { files: found, missing };
}

export function placeUnder(linked: string, path: string): { path: string; folder: string; top: string } {
  const under = underFolder(linked, path) ?? path;
  const slash = under.lastIndexOf("/");
  const folder = slash === -1 ? "" : under.slice(0, slash);
  const firstSlash = folder.indexOf("/");
  return { path: under, folder, top: firstSlash === -1 ? folder : folder.slice(0, firstSlash) };
}

export function onGitHubFiles(states: VaultStates): string[] {
  const found: string[] = [];
  for (const file of states.files.values()) {
    const compared = comparedOf(file.state);

    if (compared === null || compared.kind !== "github" || onlyGitHubHas(file, compared)) continue;
    found.push(file.path);
  }
  return found.sort(byName);
}

const onlyGitHubHas = (file: VaultFile, compared: Compared): boolean => file.sha === null && compared.kind === "github" && compared.change === "new";
