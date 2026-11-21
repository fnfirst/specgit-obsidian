import type { BlobsAnswer, BranchFile } from "../auth/git-copy";
import { type DocumentRef, isHiddenPath } from "../mapping";
import { gitBlobShaOfText } from "./blob-sha";
import { comparedOf, type VaultFile } from "./vault-state";

export interface BroughtNewer {
  brought: number;
  skipped: number;
}

export interface BringInNewerPorts {
  files(): ReadonlyMap<string, VaultFile> | null;
  read(path: string): Promise<string | null>;
  bringIn(path: string): Promise<boolean>;
}

export async function bringInNewer(ports: BringInNewerPorts): Promise<BroughtNewer> {
  const files = ports.files();
  const result: BroughtNewer = { brought: 0, skipped: 0 };
  if (files === null) return result;
  for (const file of [...files.values()]) {
    const state = comparedOf(file.state);
    if (!state || state.kind !== "github" || state.change !== "updated" || file.sha === null) continue;
    const text = await ports.read(file.path);
    if (text === null || gitBlobShaOfText(text) !== file.sha || !(await ports.bringIn(file.path))) result.skipped++;
    else result.brought++;
  }
  return result;
}

export interface DraftSource {
  doc: DocumentRef;
  branch: string;
  blob: string | null;
}

export interface BringInDraftPorts {
  draftOf(path: string): DraftSource | null;
  gitBlobsByOid?(repo: string, files: ReadonlyArray<{ sha: string; path: string }>): Promise<BlobsAnswer>;
  branchFile(doc: DocumentRef, branch: string): Promise<BranchFile>;
  vaultPaths(): Iterable<string>;
  create(path: string, text: string): Promise<"created" | "exists" | "failed">;
  bringFor?(path: string, text: string): Promise<void>;
}

export type BroughtDraft = { kind: "brought" } | { kind: "exists" } | { kind: "none" } | { kind: "unreadable" } | { kind: "failed" };

export async function bringInDraft(ports: BringInDraftPorts, path: string): Promise<BroughtDraft> {
  const draft = ports.draftOf(path);
  if (draft === null || isHiddenPath(path)) return { kind: "none" };
  const key = path.toLowerCase();
  const here = (): boolean => [...ports.vaultPaths()].some((one) => one.toLowerCase() === key);
  if (here()) return { kind: "exists" };
  const text = await draftText(ports, draft);
  if (text === null) return { kind: "unreadable" };
  if (here()) return { kind: "exists" };
  const made = await ports.create(path, text);
  if (made === "exists") return { kind: "exists" };
  if (made !== "created") return { kind: "failed" };
  try {
    await ports.bringFor?.(path, text);
  } catch {
    void 0;
  }
  return { kind: "brought" };
}

async function draftText(ports: BringInDraftPorts, draft: DraftSource): Promise<string | null> {
  if (draft.blob !== null && ports.gitBlobsByOid) {
    const answer = await ports.gitBlobsByOid(draft.doc.repo, [{ sha: draft.blob, path: draft.doc.path }]);
    if (answer.kind === "answered") {
      const read = answer.files.get(draft.blob);
      if (read?.kind === "text") return read.text;
    }
  }
  const file = await ports.branchFile(draft.doc, draft.branch);
  return file.kind === "file" ? file.text : null;
}
