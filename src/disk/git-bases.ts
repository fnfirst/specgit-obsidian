import { isTextOfBytes } from "../changes/blob-sha";
import { type DocumentRef, docKey } from "../mapping";
import { GIT_COPY_PATIENCE_MS, within } from "../patience";
import { BASE_LIMITS, type BaseStore } from "./bases";
import { withoutFinalBreaks } from "./diff";
import { eolOf, toLf } from "./line-endings";
import type { VaultPort } from "./vault";

export interface GitBasesDeps {
  bases: BaseStore;

  vault: Pick<VaultPort, "read" | "onRename" | "onDelete">;

  documentFor: (path: string) => DocumentRef | null;

  gitCopy: (doc: DocumentRef) => Promise<string | null>;
  signedIn: () => boolean;

  repoSha?: (path: string) => string | null;
}

export const MISSED_LIMIT = 25;

export class GitBases {

  private readonly asked = new Set<string>();

  private readonly under = new Map<string, Promise<void>>();

  private readonly missed = new Map<string, DocumentRef>();

  constructor(private readonly deps: GitBasesDeps) {}

  watch(): () => void {
    const { vault } = this.deps;
    const stops = [vault.onDelete((path) => this.gone(path)), vault.onRename((from, to) => this.renamed(from, to))];
    return () => stops.forEach((stop) => stop());
  }

  opened(path: string, doc: DocumentRef): void {
    if (this.asked.has(path) || this.deps.bases.has(path)) return;
    if (!this.deps.signedIn()) {
      this.missed.delete(path);
      this.missed.set(path, doc);
      if (this.missed.size > MISSED_LIMIT) this.missed.delete(this.missed.keys().next().value ?? path);
      return;
    }
    this.missed.delete(path);
    this.asked.add(path);

    const recording: Promise<void> = within(this.record(path, doc), GIT_COPY_PATIENCE_MS, undefined).finally(() => {
      if (this.under.get(path) === recording) this.under.delete(path);
    });
    this.under.set(path, recording);
  }

  resume(): void {
    for (const [path, doc] of [...this.missed]) this.opened(path, doc);
  }

  underway(path: string): Promise<void> | null {
    return this.under.get(path) ?? null;
  }

  private gone(path: string): void {
    const read = this.deps.bases.read(path);
    if (read.status === "found" && read.base.room === null) this.deps.bases.forget(path);
    this.asked.delete(path);
    this.missed.delete(path);
  }

  private renamed(from: string, to: string): void {
    const read = this.deps.bases.read(from);
    const doc = this.deps.documentFor(to);

    if (read.status === "found" && read.base.room === null && doc && read.base.doc === docKey(doc)) {
      this.deps.bases.move(from, to);
      this.asked.delete(from);
      this.asked.add(to);
    } else this.gone(from);
  }

  private async record(path: string, doc: DocumentRef): Promise<void> {
    try {
      const file = await this.deps.vault.read(path);

      if (file === null || file.length > BASE_LIMITS.note) return;
      const known = this.deps.repoSha?.(path) ?? null;

      const held = known !== null && isTextOfBytes(file, known) ? file : await this.deps.gitCopy(doc);
      const mine = toLf(file);
      if (held === null || withoutFinalBreaks(mine) !== withoutFinalBreaks(toLf(held))) return;

      if ((await this.deps.vault.read(path)) === null || this.deps.bases.has(path)) return;
      this.deps.bases.write(path, { room: null, doc: docKey(doc), text: mine, eol: eolOf(file), lineage: [] });
    } catch { /* empty */ }
  }
}
