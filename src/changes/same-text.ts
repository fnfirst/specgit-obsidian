import { withEol } from "../disk/line-endings";
import { type DocumentRef, pathKind } from "../mapping";
import { opensUnclosedFence, sameCanvasText, sameDocumentText } from "../shared/review-flow";
import { gitBlobSha, gitBlobShaOfText } from "./blob-sha";
import { unchangedHere } from "./unchanged-here";
import type { CacheEntry, FileCache } from "./cache";

export type Sameness = "same" | "differs" | "unknown" | "needs-read";

const BOM = "\uFEFF";

export function layoutShas(text: string): Set<string> {
  const lf = (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, "\n");
  const core = lf.replace(/\n+$/, "");
  const tails = core === "" ? [""] : opensUnclosedFence(lf) ? [lf.slice(core.length)] : ["", "\n", "\n\n"];
  const shas = new Set<string>();
  for (const bom of ["", BOM]) {
    for (const eol of ["lf", "crlf"] as const) {
      for (const tail of tails) shas.add(gitBlobShaOfText(bom + withEol(core + tail, eol)));
    }
  }
  return shas;
}

const hasFrontMatter = (text: string): boolean => /^---[ \t]*\r?\n/.test(text.replace(/^\uFEFF/, ""));

export interface SameTextDeps {
  readBytes(path: string): Promise<ArrayBuffer | null>;
  readBlob(doc: DocumentRef, sha: string): Promise<string | null>;
}

export async function sameAsRepo(deps: SameTextDeps, path: string, doc: DocumentRef, sha: string, repoSha: string, mayRead: boolean): Promise<Sameness> {
  const kind = pathKind(path);
  const board = kind === "board";
  if (!board && !/\.md$/i.test(path)) return "differs";
  if (board && !mayRead) return "needs-read";
  const bytes = await deps.readBytes(path);
  if (bytes === null || (await gitBlobSha(bytes)) !== sha) return "unknown";
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  if (!board) {
    if (layoutShas(text).has(repoSha)) return "same";
    if (!hasFrontMatter(text)) return "differs";
  }
  if (!mayRead) return "needs-read";
  const theirs = await deps.readBlob(doc, repoSha);
  if (theirs === null) return "unknown";
  return (board ? sameCanvasText(theirs, text) : sameDocumentText(theirs, text)) ? "same" : "differs";
}

export const SAME_PER_LOOK = 12;
const AT_ONCE = 4;

export interface SettleSameness {
  files: ReadonlyMap<string, CacheEntry>;
  repo: ReadonlyMap<string, string>;
  cache: Pick<FileCache, "sameAs" | "differsFrom">;
  ask: (path: string, doc: DocumentRef, sha: string, repoSha: string, mayRead: boolean) => Promise<Sameness>;
  documentFor: (path: string) => DocumentRef | null;
  alive: () => boolean;
  unsure: Map<string, number>;
  notBase: Set<string>;
  now: () => number;
  prefetch?: (reads: ReadonlyArray<{ doc: DocumentRef; sha: string }>) => Promise<void>;
}

export const UNSURE_FOR_MS = 60_000;

interface Comparison {
  path: string;
  doc: DocumentRef;
  sha: string;
  against: string;
  base: boolean;
  repoSha: string | undefined;
}

export async function settleSameness({ files, repo, cache, ask, documentFor, alive, unsure, notBase, now, prefetch }: SettleSameness): Promise<number> {
  const queue: Comparison[] = [];
  const first: Comparison[] = [];
  for (const [path, entry] of files) {
    const repoSha = repo.get(path);
    const doc = documentFor(path);
    if (!doc || repoSha === entry.sha || unchangedHere(entry) || (repoSha !== undefined && entry.same === repoSha)) continue;
    const against = (blob: string): boolean => (unsure.get(`${entry.sha}|${blob}`) ?? 0) > now();
    if (entry.base !== null && entry.base !== repoSha && !notBase.has(`${entry.sha}|${entry.base}`)) {
      if (!against(entry.base)) first.push({ path, doc, sha: entry.sha, against: entry.base, base: true, repoSha });
      continue;
    }
    if (repoSha === undefined || entry.differs === repoSha || against(repoSha)) continue;
    first.push({ path, doc, sha: entry.sha, against: repoSha, base: false, repoSha });
  }
  const answer = (one: Comparison, result: Sameness): Comparison | null => {
    if (result === "same") cache.sameAs(one.path, one.sha, one.against);
    else if (result === "unknown") unsure.set(`${one.sha}|${one.against}`, now() + UNSURE_FOR_MS);
    else if (result === "differs" && !one.base) cache.differsFrom(one.path, one.sha, one.against);
    else if (result === "differs") {
      notBase.add(`${one.sha}|${one.against}`);
      const repoSha = one.repoSha;
      if (repoSha !== undefined && files.get(one.path)?.same !== repoSha && files.get(one.path)?.differs !== repoSha && (unsure.get(`${one.sha}|${repoSha}`) ?? 0) <= now()) return { ...one, against: repoSha, base: false };
    }
    return null;
  };
  for (let at = 0; at < first.length; at++) {
    const one = first[at]!;
    if (!alive()) return 0;
    const result = await ask(one.path, one.doc, one.sha, one.against, false);
    if (result === "needs-read") queue.push(one);
    else {
      const next = answer(one, result);
      if (next) first.push(next);
    }
  }
  if (prefetch && queue.length > 0 && alive()) await prefetch(queue.slice(0, SAME_PER_LOOK).map((one) => ({ doc: one.doc, sha: one.against })));
  let reads = 0;
  const worker = async (): Promise<void> => {
    while (reads < SAME_PER_LOOK && queue.length > 0) {
      if (!alive()) return;
      reads++;
      const one = queue.shift()!;
      const next = answer(one, await ask(one.path, one.doc, one.sha, one.against, true));
      if (next) queue.push(next);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
  return queue.length;
}
