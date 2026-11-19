import type { BaseStore } from "../disk/bases";
import { eolOf, toLf } from "../disk/line-endings";
import { type DocumentRef, docKey } from "../mapping";

export function recordMainBase(bases: BaseStore, path: string, doc: DocumentRef, raw: string): void {
  const read = bases.read(path);
  if (read.status === "found" && read.base.room !== null) return;
  recordGitBase(bases, path, doc, raw);
}

export function recordGitBase(bases: BaseStore, path: string, doc: DocumentRef, raw: string): void {
  bases.write(path, { room: null, doc: docKey(doc), text: toLf(raw), eol: eolOf(raw), lineage: [] });
}

export function keepGitBase(bases: BaseStore, path: string, doc: DocumentRef, raw: string): () => void {
  const before = bases.read(path);
  recordGitBase(bases, path, doc, raw);
  return () => {
    if (before.status === "found") bases.write(path, before.base);
    else if (before.status === "none") bases.forget(path);
  };
}
