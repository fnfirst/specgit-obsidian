import type { LocalState } from "../disk/bases";
import { hashText } from "../hash";
import { gitBlobSha } from "./blob-sha";

export interface CacheEntry {
  mtime: number;
  size: number;
  sha: string;
  at: number;
  base: string | null;
  sent?: string;
  sentTo?: string;
  agreed?: string;
  sentCommit?: string;
  sentAt?: number;
  same?: string;
  sameBy?: "server";
  differs?: string;
}

export interface Listed {
  path: string;
  mtime: number;
  size: number;
}

export interface Gone {
  path: string;
  sha: string;
  base: string | null;
}

export interface Scanned {
  files: Map<string, CacheEntry>;
  gone: Gone[];
  hashed: number;
}

const KEY_PREFIX = "specgit-file-cache";
export const SLICE_MS = 12;
export const SCAN_CONCURRENCY = 4;
export const RACY_MS = 2_000;
export const COPIED_KEPT_MS = 10 * 60_000;

const sentOf = (entry: CacheEntry | undefined): Pick<CacheEntry, "sent" | "sentTo" | "agreed" | "sentCommit" | "sentAt"> =>
  entry?.sent
    ? { sent: entry.sent, ...(entry.sentTo === undefined ? {} : { sentTo: entry.sentTo }), ...(entry.agreed === undefined ? {} : { agreed: entry.agreed }), ...(entry.sentCommit === undefined ? {} : { sentCommit: entry.sentCommit }), ...(entry.sentAt === undefined ? {} : { sentAt: entry.sentAt }) }
    : {};

export const agreedOf = (entry: Pick<CacheEntry, "sha" | "sent" | "agreed">): string | undefined => entry.agreed ?? (entry.sent !== undefined && entry.sha === entry.sent ? entry.sha : undefined);

const isEntry = (value: unknown): value is CacheEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.mtime === "number" && typeof entry.size === "number" && typeof entry.sha === "string" && typeof entry.at === "number" && (entry.base === null || typeof entry.base === "string") && (entry.sent === undefined || typeof entry.sent === "string") && (entry.sentTo === undefined || typeof entry.sentTo === "string") && (entry.agreed === undefined || typeof entry.agreed === "string") && (entry.sentCommit === undefined || typeof entry.sentCommit === "string") && (entry.sentAt === undefined || typeof entry.sentAt === "number") && (entry.same === undefined || typeof entry.same === "string") && (entry.sameBy === undefined || entry.sameBy === "server") && (entry.differs === undefined || typeof entry.differs === "string");
};

export class FileCache {
  private entries = new Map<string, CacheEntry>();
  private removed = new Map<string, Gone>();
  private foreign = new Map<string, string>();
  private readonly copied = new Map<string, { sha: string; at: number }>();
  private dirty = false;

  private readonly key: string;

  constructor(
    place: string,
    private readonly state: LocalState,
    private readonly now: () => number = Date.now,
  ) {
    this.key = `${KEY_PREFIX}-${hashText(place)}`;
    this.load();
  }

  private load(): void {
    try {
      const stored = this.state.load(this.key);
      const record = typeof stored === "object" && stored !== null ? (stored as { files?: unknown; removed?: unknown; foreign?: unknown; copied?: unknown }) : {};
      for (const [path, kept] of Object.entries((typeof record.copied === "object" && record.copied !== null ? record.copied : {}) as Record<string, unknown>)) {
        if (Array.isArray(kept) && typeof kept[0] === "string" && typeof kept[1] === "number") this.copied.set(path, { sha: kept[0], at: kept[1] });
      }
      for (const [path, entry] of Object.entries((record.files ?? {}) as Record<string, unknown>)) if (isEntry(entry)) this.entries.set(path, entry);
      for (const [path, sha] of Object.entries((typeof record.foreign === "object" && record.foreign !== null ? record.foreign : {}) as Record<string, unknown>)) if (typeof sha === "string") this.foreign.set(path, sha);
      for (const gone of Array.isArray(record.removed) ? (record.removed as unknown[]) : []) {
        const candidate = gone as Partial<Gone> | null;
        if (candidate && typeof candidate.path === "string" && typeof candidate.sha === "string") this.removed.set(candidate.path, { path: candidate.path, sha: candidate.sha, base: candidate.base ?? null });
      }
    } catch {
      void 0;
    }
  }

  save(): void {
    if (!this.dirty) return;
    try {
      this.state.save(this.key, { files: Object.fromEntries(this.entries), removed: [...this.removed.values()], ...(this.foreign.size > 0 ? { foreign: Object.fromEntries(this.foreign) } : {}), ...(this.copied.size > 0 ? { copied: Object.fromEntries([...this.copied].map(([path, one]) => [path, [one.sha, one.at]])) } : {}) });
      this.dirty = false;
    } catch {
      void 0;
    }
  }

  get(path: string): CacheEntry | undefined {
    return this.entries.get(path);
  }

  matchedFiles(): Map<string, string> {
    return new Map([...this.entries].filter(([, entry]) => entry.base !== null).map(([path, entry]) => [path, entry.sha]));
  }

  inherit(files: ReadonlyMap<string, string>): void {
    if (files.size === 0) return;
    this.foreign = new Map([...this.foreign, ...files]);
    this.dirty = true;
    this.save();
  }

  foreignFiles(): ReadonlyMap<string, string> {
    return this.foreign;
  }

  clearForeign(paths: Iterable<string>): void {
    for (const path of paths) this.dirty = this.foreign.delete(path) || this.dirty;
  }

  deleted(): Gone[] {
    return [...this.removed.values()];
  }

  async scan(
    listed: readonly Listed[],
    read: (path: string) => Promise<ArrayBuffer>,
    pause: () => Promise<void> = () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    clock: () => number = () => performance.now(),
  ): Promise<Scanned> {
    const next = new Map<string, CacheEntry>();
    const stale: Listed[] = [];
    for (const file of listed) {
      const before = this.entries.get(file.path);
      if (before && before.mtime === file.mtime && before.size === file.size && before.at - file.mtime > RACY_MS) next.set(file.path, before);
      else stale.push(file);
    }
    let hashed = 0;
    let at = 0;
    let sliceStart = clock();
    const work = async (): Promise<void> => {
      while (at < stale.length) {
        const file = stale[at++]!;
        const before = this.entries.get(file.path);
        let bytes: ArrayBuffer;
        try {
          bytes = await read(file.path);
        } catch {
          if (before) next.set(file.path, before);
          continue;
        }
        const sha = await gitBlobSha(bytes);
        hashed++;
        const written = this.copied.get(file.path)?.sha;
        this.copied.delete(file.path);
        next.set(file.path, { mtime: file.mtime, size: file.size, sha, at: this.now(), base: before?.base ?? this.removed.get(file.path)?.base ?? (written === sha ? sha : null), ...sentOf(before), ...(before?.same && before.sha === sha ? { same: before.same, ...(before.sameBy ? { sameBy: before.sameBy } : {}) } : {}), ...(before?.differs && before.sha === sha ? { differs: before.differs } : {}) });
        this.removed.delete(file.path);
        if (clock() - sliceStart >= SLICE_MS && at < stale.length) {
          await pause();
          sliceStart = clock();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, stale.length) }, work));
    const present = new Set<string>();
    const files = new Map<string, CacheEntry>();
    for (const file of listed) {
      present.add(file.path);
      const entry = next.get(file.path);
      if (!entry) continue;
      const live = this.entries.get(file.path);
      if (live && (live.base !== entry.base || live.sent !== entry.sent || live.sentTo !== entry.sentTo || live.agreed !== entry.agreed || live.sentCommit !== entry.sentCommit || live.sentAt !== entry.sentAt || (live.sha === entry.sha && (live.same !== entry.same || live.sameBy !== entry.sameBy || live.differs !== entry.differs)))) {
        const { sent: _was, sentTo: _to, agreed: _agreed, sentCommit: _commit, sentAt: _at, same: _same, sameBy: _by, differs: _differs, ...rest } = entry;
        files.set(file.path, { ...rest, base: live.base, ...sentOf(live), ...(live.same && live.sha === entry.sha ? { same: live.same, ...(live.sameBy ? { sameBy: live.sameBy } : {}) } : {}), ...(live.differs && live.sha === entry.sha ? { differs: live.differs } : {}) });
      } else files.set(file.path, entry);
    }
    const gone: Gone[] = [];
    for (const [path, entry] of this.entries) {
      if (present.has(path)) continue;
      const lost = { path, sha: entry.sha, base: entry.base };
      this.removed.set(path, lost);
      gone.push(lost);
    }
    this.entries = files;
    for (const [path, one] of this.copied) {
      if (!present.has(path) && this.now() - one.at > COPIED_KEPT_MS) {
        this.copied.delete(path);
        this.dirty = true;
      }
    }
    this.dirty ||= hashed > 0 || gone.length > 0;
    this.save();
    return { files, gone, hashed };
  }

  copiedFrom(path: string, sha: string): void {
    this.copied.set(path, { sha, at: this.now() });
    this.dirty = true;
  }

  matched(path: string, sha: string): void {
    const entry = this.entries.get(path);
    if (entry?.sha !== sha || entry.base === sha) return;
    this.entries.set(path, { ...entry, base: sha });
    this.dirty = true;
  }

  rebased(path: string, sha: string): void {
    const entry = this.entries.get(path);
    if (!entry || entry.base === sha) return;
    this.entries.set(path, { ...entry, base: sha });
    this.dirty = true;
  }

  sentAs(path: string, sha: string | null, to: string | null = null, agreement: { agreed?: string; commit?: string; at?: number } = {}): void {
    const entry = this.entries.get(path);
    const next: Pick<CacheEntry, "sent" | "sentTo" | "agreed" | "sentCommit" | "sentAt"> =
      sha === null ? {} : { sent: sha, ...(to === null ? {} : { sentTo: to }), ...(agreement.agreed === undefined ? {} : { agreed: agreement.agreed }), ...(agreement.commit === undefined ? {} : { sentCommit: agreement.commit }), ...(agreement.at === undefined ? {} : { sentAt: agreement.at }) };
    if (!entry || (entry.sent === next.sent && entry.sentTo === next.sentTo && entry.agreed === next.agreed && entry.sentCommit === next.sentCommit && entry.sentAt === next.sentAt)) return;
    const { sent: _was, sentTo: _to, agreed: _agreed, sentCommit: _commit, sentAt: _at, ...rest } = entry;
    this.entries.set(path, { ...rest, ...next });
    this.dirty = true;
  }

  agreedAs(path: string, agreed: string): void {
    const entry = this.entries.get(path);
    if (!entry?.sent || entry.agreed === agreed) return;
    this.entries.set(path, { ...entry, agreed });
    this.dirty = true;
  }

  sameAs(path: string, sha: string, repoSha: string, by?: "server"): void {
    const entry = this.entries.get(path);
    if (!entry || entry.sha !== sha || (entry.same === repoSha && entry.sameBy === by)) return;
    const { differs: _differs, sameBy: _by, ...rest } = entry;
    this.entries.set(path, { ...rest, same: repoSha, ...(by ? { sameBy: by } : {}) });
    this.dirty = true;
  }

  differsFrom(path: string, sha: string, repoSha: string): void {
    const entry = this.entries.get(path);
    if (!entry || entry.sha !== sha || entry.differs === repoSha) return;
    this.entries.set(path, { ...entry, differs: repoSha });
    this.dirty = true;
  }

  settled(path: string): void {
    this.dirty ||= this.removed.delete(path);
    this.save();
  }
}
