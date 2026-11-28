import { withEol } from "../disk/line-endings";
import { type DocumentRef, pathKind } from "../mapping";
import { opensUnclosedFence, sameCanvasText, sameDocumentText } from "../shared/review-flow";
import { gitBlobSha, gitBlobShaOfText } from "./blob-sha";
import { sameBaseText } from "./same-base";
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

export function sameStructuredText(path: string, theirs: string, ours: string): boolean {
  const kind = pathKind(path);
  return kind === "board" ? sameCanvasText(theirs, ours) : kind === "base" && sameBaseText(theirs, ours);
}

export function sameFileText(path: string, theirs: string, ours: string): boolean {
  const kind = pathKind(path);
  if (kind === "board") return sameCanvasText(theirs, ours);
  if (kind === "base") return sameBaseText(theirs, ours);
  return kind === "note" && sameDocumentText(theirs, ours);
}

export async function sameAsRepo(deps: SameTextDeps, path: string, doc: DocumentRef, sha: string, repoSha: string, mayRead: boolean): Promise<Sameness> {
  const kind = pathKind(path);
  const structured = kind === "board" || kind === "base";
  if (!structured && kind !== "note") return "differs";
  const bytes = await deps.readBytes(path);
  if (bytes === null || (await gitBlobSha(bytes)) !== sha) return "unknown";
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  if (layoutShas(text).has(repoSha) && (kind !== "board" || sameCanvasText(text, text))) return "same";
  if (!structured && !hasFrontMatter(text)) return "differs";
  if (!mayRead) return "needs-read";
  const theirs = await deps.readBlob(doc, repoSha);
  if (theirs === null) return "unknown";
  return sameFileText(path, theirs, text) ? "same" : "differs";
}

export const SAME_PER_LOOK = 24;
export const BLOB_CACHE_MAX = 200;
const AT_ONCE = 4;

export class BlobCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly max = BLOB_CACHE_MAX) {}

  get(key: string): string | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: string): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

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
  stage: "base" | "repo" | "sent";
  repoSha: string | undefined;
}

export async function settleSameness({ files, repo, cache, ask, documentFor, alive, unsure, notBase, now, prefetch }: SettleSameness): Promise<number> {
  const queue: Comparison[] = [];
  const first: Comparison[] = [];
  const nextTarget = (
    entry: CacheEntry,
    repoSha: string | undefined,
    after?: "base" | "repo",
  ): { against: string; stage: "base" | "repo" | "sent" } | null => {
    const against = (blob: string): boolean => (unsure.get(`${entry.sha}|${blob}`) ?? 0) > now();
    if (after === undefined && entry.base !== null && entry.base !== repoSha && !notBase.has(`${entry.sha}|${entry.base}`)) {
      return against(entry.base) ? null : { against: entry.base, stage: "base" };
    }
    if (after !== "repo" && repoSha !== undefined && entry.same !== repoSha && entry.differs !== repoSha && !notBase.has(`${entry.sha}|${repoSha}`)) {
      return against(repoSha) ? null : { against: repoSha, stage: "repo" };
    }
    if (
      entry.sent !== undefined &&
      entry.sent !== entry.sha &&
      entry.sent !== repoSha &&
      entry.sent !== entry.base &&
      entry.same !== entry.sent &&
      !notBase.has(`${entry.sha}|${entry.sent}`)
    ) {
      return against(entry.sent) ? null : { against: entry.sent, stage: "sent" };
    }
    return null;
  };
  const chainedTargets = (entry: CacheEntry, repoSha: string | undefined, fromStage: "base" | "repo" | "sent"): Array<{ against: string; stage: "base" | "repo" | "sent" }> => {
    const out: Array<{ against: string; stage: "base" | "repo" | "sent" }> = [];
    let stage: "base" | "repo" | "sent" = fromStage;
    while (stage !== "sent") {
      const next = nextTarget(entry, repoSha, stage);
      if (!next) break;
      out.push(next);
      stage = next.stage;
    }
    return out;
  };
  for (const [path, entry] of files) {
    const repoSha = repo.get(path);
    const doc = documentFor(path);
    if (!doc || repoSha === entry.sha || unchangedHere(entry) || (repoSha !== undefined && entry.same === repoSha)) continue;
    const picked = nextTarget(entry, repoSha);
    if (picked) first.push({ path, doc, sha: entry.sha, against: picked.against, stage: picked.stage, repoSha });
  }
  const answer = (one: Comparison, result: Sameness): Comparison | null => {
    if (result === "same") cache.sameAs(one.path, one.sha, one.against);
    else if (result === "unknown") unsure.set(`${one.sha}|${one.against}`, now() + UNSURE_FOR_MS);
    else if (result === "differs") {
      if (one.stage === "repo") cache.differsFrom(one.path, one.sha, one.against);
      notBase.add(`${one.sha}|${one.against}`);
      if (one.stage !== "sent") {
        const current = files.get(one.path);
        const chained = current ? nextTarget(current, one.repoSha, one.stage) : null;
        if (chained) return { ...one, against: chained.against, stage: chained.stage };
      }
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
  const chainedPrefetched = new Set<string>();
  if (prefetch && queue.length > 0 && alive()) {
    const toPrefetch: Array<{ doc: DocumentRef; sha: string }> = [];
    const seen = new Set<string>();
    const addRead = (doc: DocumentRef, sha: string): void => {
      const key = `${doc.repo}\n${sha}`;
      if (seen.has(key)) return;
      seen.add(key);
      toPrefetch.push({ doc, sha });
    };
    for (const one of queue.slice(0, SAME_PER_LOOK)) {
      addRead(one.doc, one.against);
      const current = files.get(one.path);
      if (current) {
        for (const chained of chainedTargets(current, one.repoSha, one.stage)) {
          if (chained.against !== one.against) {
            addRead(one.doc, chained.against);
            chainedPrefetched.add(`${one.path}\n${one.sha}\n${chained.against}`);
          }
        }
      }
    }
    if (toPrefetch.length > 0) await prefetch(toPrefetch);
  }
  let reads = 0;
  const worker = async (): Promise<void> => {
    while (reads < SAME_PER_LOOK && queue.length > 0) {
      if (!alive()) return;
      reads++;
      const one = queue.shift()!;
      let next = answer(one, await ask(one.path, one.doc, one.sha, one.against, true));
      while (next && chainedPrefetched.has(`${next.path}\n${next.sha}\n${next.against}`)) {
        if (!alive()) return;
        next = answer(next, await ask(next.path, next.doc, next.sha, next.against, true));
      }
      if (next) queue.push(next);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
  return queue.length;
}
