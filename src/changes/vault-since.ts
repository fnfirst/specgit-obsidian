import type { MainFile } from "../auth/git-copy";
import { changesBetween } from "../disk/merge";
import { stripBom, toLf } from "../disk/line-endings";
import type { Shown } from "../disk/regions";
import { type DocumentRef, noteName, pathKind } from "../mapping";
import { THING_WORDS } from "../pick/words";
import { type ChangesContext, GITHUB_GONE, GITHUB_UNREADABLE, githubSame, GONE_FROM_VAULT, mineSame, sameAsGitHub } from "../review/words";
import type { Compared, VaultFile } from "./vault-state";
import { VAULT_UNREADABLE } from "./vault-words";

export type SinceView = "yours" | "mine" | "github" | "difference";

export function viewsOf(compared: Compared): SinceView[] {
  switch (compared.kind) {
    case "here":
      return compared.change === "edited" || compared.change === "new" ? ["yours"] : [];
    case "github":
      return compared.change === "updated" ? ["github"] : [];
    case "both":
      if (compared.baseUnknown) return compared.here === "edited" && compared.github === "edited" ? ["difference"] : [];
      if (compared.here === "deleted") return ["github"];
      return compared.github === "edited" ? ["mine", "github"] : ["mine"];
    default:
      return [];
  }
}

export interface SinceReads {
  readText(path: string): Promise<string | null>;
  gitBlob(doc: DocumentRef, sha: string): Promise<string | null>;
  gitFile(doc: DocumentRef): Promise<MainFile>;
}

export type SinceRead = { kind: "shown"; shown: Shown[]; context: ChangesContext } | { kind: "said"; words: string };

type Got<T> = { ok: true; value: T } | { ok: false };
const attempt = async <T>(read: () => Promise<T>): Promise<Got<T>> => {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
};

export async function readSince(reads: SinceReads, doc: DocumentRef, file: VaultFile, view: Exclude<SinceView, "yours">): Promise<SinceRead> {
  if (view !== "difference" && file.base === null) throw new Error(`The ${view} view of a file needs the blob it last matched GitHub's file as`);
  const what = THING_WORDS[pathKind(file.path)];
  const name = noteName(file.path);
  const said = (words: string): SinceRead => ({ kind: "said", words });
  const laid = (before: string, after: string, same: string, context: ChangesContext): SinceRead => {
    const shown = changesBetween(stripBom(toLf(before)), stripBom(toLf(after)));
    return shown === null ? said(same) : { kind: "shown", shown, context };
  };
  const base = (): Promise<string | null> => reads.gitBlob(doc, file.base as string);
  if (view === "mine") {
    const [before, here] = await Promise.all([attempt(base), attempt(() => reads.readText(file.path))]);
    if (!here.ok) return said(VAULT_UNREADABLE);
    if (here.value === null) return said(GONE_FROM_VAULT);
    if (!before.ok || before.value === null) return said(GITHUB_UNREADABLE);
    return laid(before.value, here.value, mineSame(what), { kind: "mine", name, what });
  }
  if (view === "github") {
    const [before, now] = await Promise.all([attempt(base), attempt(() => reads.gitFile(doc))]);
    if (!now.ok || now.value.kind === "unreadable") return said(GITHUB_UNREADABLE);
    if (now.value.kind === "absent") return said(GITHUB_GONE);
    if (!before.ok || before.value === null) return said(GITHUB_UNREADABLE);
    return laid(before.value, now.value.text, githubSame(what), { kind: "github", name, what });
  }
  const [here, now] = await Promise.all([attempt(() => reads.readText(file.path)), attempt(() => reads.gitFile(doc))]);
  if (!here.ok) return said(VAULT_UNREADABLE);
  if (here.value === null) return said(GONE_FROM_VAULT);
  if (!now.ok || now.value.kind === "unreadable") return said(GITHUB_UNREADABLE);
  if (now.value.kind === "absent") return said(GITHUB_GONE);
  return laid(here.value, now.value.text, sameAsGitHub(what), { kind: "difference", name, what });
}
