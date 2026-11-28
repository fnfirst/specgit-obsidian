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
  localOnly?: true;
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
  localOnly?: true;
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
export const CACHE_SAVE_DEBOUNCE_MS = 30_000;
export const RETIRED_DRAFT_TTL_MS = 5 * 60_000;
export const REVIEW_TOMBSTONE_TTL_MS = 15 * 60_000;
export const RETIRED_DRAFT_SETTLE_MS = 60_000;
export const MAX_FOREIGN = 5_000;
export const MAX_REMOVED = 5_000;

export type SaveScheduler = (run: () => void, ms: number) => () => void;

const defaultSchedule: SaveScheduler = (run, ms) => {
  const timer = window.setTimeout(run, ms);
  return () => window.clearTimeout(timer);
};

function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const sentOf = (entry: CacheEntry | undefined): Pick<CacheEntry, "sent" | "sentTo" | "agreed" | "sentCommit" | "sentAt"> =>
  entry?.sent
    ? { sent: entry.sent, ...(entry.sentTo === undefined ? {} : { sentTo: entry.sentTo }), ...(entry.agreed === undefined ? {} : { agreed: entry.agreed }), ...(entry.sentCommit === undefined ? {} : { sentCommit: entry.sentCommit }), ...(entry.sentAt === undefined ? {} : { sentAt: entry.sentAt }) }
    : {};

export const clearSent = (entry: CacheEntry): void => {
  delete entry.sent;
  delete entry.sentTo;
  delete entry.agreed;
  delete entry.sentCommit;
  delete entry.sentAt;
};

const withMeta = (
  core: Pick<CacheEntry, "mtime" | "size" | "sha" | "at">,
  base: string | null,
  from: CacheEntry | undefined,
): CacheEntry => ({
  ...core,
  base,
  ...sentOf(from),
  ...(from?.localOnly && base === null && from.sent === undefined ? { localOnly: true as const } : {}),
  ...(from?.same && from.sha === core.sha ? { same: from.same, ...(from.sameBy ? { sameBy: from.sameBy } : {}) } : {}),
  ...(from?.differs && from.sha === core.sha ? { differs: from.differs } : {}),
});

export const agreedOf = (entry: Pick<CacheEntry, "sha" | "sent" | "agreed">): string | undefined => entry.agreed ?? (entry.sent !== undefined && entry.sha === entry.sent ? entry.sha : undefined);

const isEntry = (value: unknown): value is CacheEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.mtime === "number" && typeof entry.size === "number" && typeof entry.sha === "string" && typeof entry.at === "number" && (entry.base === null || typeof entry.base === "string") && (entry.sent === undefined || typeof entry.sent === "string") && (entry.sentTo === undefined || typeof entry.sentTo === "string") && (entry.agreed === undefined || typeof entry.agreed === "string") && (entry.sentCommit === undefined || typeof entry.sentCommit === "string") && (entry.sentAt === undefined || typeof entry.sentAt === "number") && (entry.same === undefined || typeof entry.same === "string") && (entry.sameBy === undefined || entry.sameBy === "server") && (entry.differs === undefined || typeof entry.differs === "string") && (entry.localOnly === undefined || entry.localOnly === true);
};

export class FileCache {
  private entries = new Map<string, CacheEntry>();
  private removed = new Map<string, Gone>();
  private foreign = new Map<string, string>();
  private readonly draftRenamedFrom = new Map<string, string[]>();
  private readonly retiredDraftSources = new Map<string, number>();
  private readonly recentlyAbandonedDrafts = new Map<string, number>();
  private readonly unflushedLiveDeletes = new Map<string, { sha: string; at: number }>();
  private readonly pendingDraftDeletes = new Set<string>();
  private readonly copied = new Map<string, { sha: string; at: number }>();
  private readonly activeScans = new Set<Set<string>>();
  private readonly activeRenameTargets = new Set<Set<string>>();
  private dirty = false;
  private pendingSave: (() => void) | null = null;

  private readonly key: string;

  constructor(
    place: string,
    private readonly state: LocalState,
    private readonly now: () => number = Date.now,
    private readonly schedule: SaveScheduler = defaultSchedule,
    private readonly debounceMs: number = CACHE_SAVE_DEBOUNCE_MS,
  ) {
    this.key = `${KEY_PREFIX}-${hashText(place)}`;
    this.load();
  }

  private load(): void {
    try {
      const stored = this.state.load(this.key);
      const record =
        typeof stored === "object" && stored !== null
          ? (stored as { files?: unknown; removed?: unknown; foreign?: unknown; copied?: unknown; draftRenames?: unknown; retiredDraftSources?: unknown; recentlyAbandonedDrafts?: unknown; unflushedLiveDeletes?: unknown; pendingDraftDeletes?: unknown })
          : {};
      for (const [path, kept] of Object.entries((typeof record.copied === "object" && record.copied !== null ? record.copied : {}) as Record<string, unknown>)) {
        if (Array.isArray(kept) && typeof kept[0] === "string" && typeof kept[1] === "number") this.copied.set(path, { sha: kept[0], at: kept[1] });
      }
      for (const [path, entry] of Object.entries((record.files ?? {}) as Record<string, unknown>)) if (isEntry(entry)) this.entries.set(path, entry);
      for (const [path, sha] of Object.entries((typeof record.foreign === "object" && record.foreign !== null ? record.foreign : {}) as Record<string, unknown>)) if (typeof sha === "string") this.foreign.set(path, sha);
      for (const [newPath, rawOld] of Object.entries((typeof record.draftRenames === "object" && record.draftRenames !== null ? record.draftRenames : {}) as Record<string, unknown>)) {
        const list = typeof rawOld === "string" ? [rawOld] : Array.isArray(rawOld) ? rawOld : [];
        const cleaned: string[] = [];
        for (const item of list) {
          if (typeof item === "string" && item !== "" && item !== newPath && !cleaned.includes(item)) cleaned.push(item);
        }
        if (cleaned.length > 0) this.draftRenamedFrom.set(newPath, cleaned);
      }
      const now = this.now();
      for (const [path, at] of Object.entries((typeof record.retiredDraftSources === "object" && record.retiredDraftSources !== null ? record.retiredDraftSources : {}) as Record<string, unknown>)) {
        if (typeof at === "number" && path !== "" && !this.entries.has(path) && now - at < RETIRED_DRAFT_TTL_MS) this.retiredDraftSources.set(path, at);
      }
      for (const [path, at] of Object.entries((typeof record.recentlyAbandonedDrafts === "object" && record.recentlyAbandonedDrafts !== null ? record.recentlyAbandonedDrafts : {}) as Record<string, unknown>)) {
        if (typeof at === "number" && path !== "" && now - at < REVIEW_TOMBSTONE_TTL_MS) this.recentlyAbandonedDrafts.set(path, at);
      }
      for (const [path, rawUnflushed] of Object.entries((typeof record.unflushedLiveDeletes === "object" && record.unflushedLiveDeletes !== null ? record.unflushedLiveDeletes : {}) as Record<string, unknown>)) {
        const item = rawUnflushed as { sha?: unknown; at?: unknown } | null;
        if (item && typeof item.sha === "string" && item.sha !== "" && typeof item.at === "number" && path !== "" && !this.entries.has(path) && now - item.at < RETIRED_DRAFT_SETTLE_MS) {
          this.unflushedLiveDeletes.set(path, { sha: item.sha, at: item.at });
        }
      }
      for (const path of Array.isArray(record.pendingDraftDeletes) ? record.pendingDraftDeletes : []) {
        if (typeof path === "string" && path !== "") this.pendingDraftDeletes.add(path);
      }
      for (const gone of Array.isArray(record.removed) ? (record.removed as unknown[]) : []) {
        const candidate = gone as Partial<Gone> | null;
        if (candidate && typeof candidate.path === "string" && typeof candidate.sha === "string") {
          this.removed.set(candidate.path, {
            path: candidate.path,
            sha: candidate.sha,
            base: candidate.base ?? null,
            ...(candidate.localOnly === true ? { localOnly: true as const } : {}),
          });
        }
      }
      capMap(this.foreign, MAX_FOREIGN);
      capMap(this.removed, MAX_REMOVED);
      capMap(this.draftRenamedFrom, MAX_REMOVED);
      capMap(this.retiredDraftSources, MAX_REMOVED);
      capMap(this.recentlyAbandonedDrafts, MAX_REMOVED);
      capMap(this.unflushedLiveDeletes, MAX_REMOVED);
    } catch {
      void 0;
    }
  }

  save(): void {
    if (!this.dirty || this.pendingSave !== null) return;
    this.pendingSave = this.schedule(() => {
      this.pendingSave = null;
      this.flush();
    }, this.debounceMs);
  }

  flush(): void {
    if (this.pendingSave !== null) {
      this.pendingSave();
      this.pendingSave = null;
    }
    if (!this.dirty) return;
    try {
      this.state.save(this.key, {
        files: Object.fromEntries(this.entries),
        removed: [...this.removed.values()],
        ...(this.foreign.size > 0 ? { foreign: Object.fromEntries(this.foreign) } : {}),
        ...(this.copied.size > 0 ? { copied: Object.fromEntries([...this.copied].map(([path, one]) => [path, [one.sha, one.at]])) } : {}),
        ...(this.draftRenamedFrom.size > 0 ? { draftRenames: Object.fromEntries(this.draftRenamedFrom) } : {}),
        ...(this.retiredDraftSources.size > 0 ? { retiredDraftSources: Object.fromEntries(this.retiredDraftSources) } : {}),
        ...(this.recentlyAbandonedDrafts.size > 0 ? { recentlyAbandonedDrafts: Object.fromEntries(this.recentlyAbandonedDrafts) } : {}),
        ...(this.unflushedLiveDeletes.size > 0 ? { unflushedLiveDeletes: Object.fromEntries(this.unflushedLiveDeletes) } : {}),
        ...(this.pendingDraftDeletes.size > 0 ? { pendingDraftDeletes: [...this.pendingDraftDeletes] } : {}),
      });
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
    for (const [path, sha] of files) {
      this.foreign.delete(path);
      this.foreign.set(path, sha);
    }
    capMap(this.foreign, MAX_FOREIGN);
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
    const scanDropped = new Set<string>();
    const scanRenamedTargets = new Set<string>();
    const next = new Map<string, CacheEntry>();
    this.activeScans.add(scanDropped);
    this.activeRenameTargets.add(scanRenamedTargets);
    try {
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
          if (scanDropped.has(file.path)) continue;
          let bytes: ArrayBuffer;
          try {
            bytes = await read(file.path);
          } catch {
            const before = this.entries.get(file.path);
            if (before && !scanDropped.has(file.path)) next.set(file.path, before);
            continue;
          }
          if (scanDropped.has(file.path)) continue;
          const sha = await gitBlobSha(bytes);
          if (scanDropped.has(file.path)) continue;
          const before = this.entries.get(file.path);
          hashed++;
          const written = this.copied.get(file.path)?.sha;
          this.copied.delete(file.path);
          const base = before?.base ?? this.removed.get(file.path)?.base ?? (written === sha ? sha : null);
          next.set(file.path, withMeta({ mtime: file.mtime, size: file.size, sha, at: this.now() }, base, before));
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
        if (scanDropped.has(file.path)) continue;
        present.add(file.path);
        const entry = next.get(file.path);
        if (!entry) continue;
        const live = this.entries.get(file.path);
        if (live && (live.base !== entry.base || live.sent !== entry.sent || live.sentTo !== entry.sentTo || live.agreed !== entry.agreed || live.sentCommit !== entry.sentCommit || live.sentAt !== entry.sentAt || live.localOnly !== entry.localOnly || (live.sha === entry.sha && (live.same !== entry.same || live.sameBy !== entry.sameBy || live.differs !== entry.differs)))) {
          files.set(file.path, withMeta({ mtime: entry.mtime, size: entry.size, sha: entry.sha, at: entry.at }, live.base, live));
        } else files.set(file.path, entry);
      }
      const gone: Gone[] = [];
      for (const [path, entry] of this.entries) {
        if (present.has(path) || scanDropped.has(path)) continue;
        const isLocalOnly = entry.localOnly === true && entry.base === null && entry.sent === undefined;
        if (!isLocalOnly && entry.base === null && entry.sent !== undefined && !entry.sentTo?.startsWith("group:") && !this.foreign.has(path) && !this.isSupersededDraftSource(path)) {
          this.pendingDraftDeletes.add(path);
          this.dirty = true;
        }
        const lost: Gone = { path, sha: entry.sha, base: entry.base, ...(isLocalOnly ? { localOnly: true as const } : {}) };
        this.removed.delete(path);
        this.removed.set(path, lost);
        gone.push(lost);
      }
      for (const [newPath, sources] of [...this.draftRenamedFrom]) {
        if (!present.has(newPath) && !scanRenamedTargets.has(newPath) && !scanDropped.has(newPath)) {
          for (const src of sources) {
            if (!present.has(src)) this.pendingDraftDeletes.add(src);
          }
          this.draftRenamedFrom.delete(newPath);
          this.dirty = true;
          continue;
        }
        const kept = sources.filter((src) => !present.has(src));
        if (kept.length === 0) {
          this.draftRenamedFrom.delete(newPath);
          this.dirty = true;
        } else if (kept.length !== sources.length) {
          this.draftRenamedFrom.set(newPath, kept);
          this.dirty = true;
        }
      }
      const scanNow = this.now();
      for (const [path, at] of [...this.retiredDraftSources]) {
        if (present.has(path) || scanNow - at >= RETIRED_DRAFT_TTL_MS) {
          this.retiredDraftSources.delete(path);
          this.dirty = true;
        }
      }
      for (const [path, at] of [...this.recentlyAbandonedDrafts]) {
        if (scanNow - at >= REVIEW_TOMBSTONE_TTL_MS) {
          this.recentlyAbandonedDrafts.delete(path);
          this.dirty = true;
        }
      }
      for (const [path, one] of [...this.unflushedLiveDeletes]) {
        if (present.has(path) || scanNow - one.at >= RETIRED_DRAFT_SETTLE_MS) {
          this.unflushedLiveDeletes.delete(path);
          this.dirty = true;
        }
      }
      capMap(this.removed, MAX_REMOVED);
      this.entries = files;
      for (const [path, sha] of [...this.foreign]) {
        if (files.get(path)?.sha !== sha) {
          this.foreign.delete(path);
          this.dirty = true;
        }
      }
      for (const [path, one] of this.copied) {
        if (!present.has(path) && this.now() - one.at > COPIED_KEPT_MS) {
          this.copied.delete(path);
          this.dirty = true;
        }
      }
      this.dirty ||= hashed > 0 || gone.length > 0;
      this.save();
      return { files, gone, hashed };
    } finally {
      this.activeScans.delete(scanDropped);
      this.activeRenameTargets.delete(scanRenamedTargets);
    }
  }

  copiedFrom(path: string, sha: string): void {
    this.copied.set(path, { sha, at: this.now() });
    this.dirty = true;
  }

  isCopied(path: string): boolean {
    return this.copied.has(path);
  }

  private applyDraftRename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    for (const scanDropped of this.activeScans) scanDropped.add(oldPath);
    for (const scanRenamedTargets of this.activeRenameTargets) scanRenamedTargets.add(newPath);
    const prior = this.draftRenamedFrom.get(oldPath) ?? [];
    this.draftRenamedFrom.delete(oldPath);
    this.retiredDraftSources.delete(newPath);
    this.unflushedLiveDeletes.delete(oldPath);
    this.unflushedLiveDeletes.delete(newPath);
    this.pendingDraftDeletes.delete(oldPath);
    const combined: string[] = [];
    for (const src of [...prior, oldPath]) {
      if (src !== "" && src !== newPath && !combined.includes(src)) combined.push(src);
    }
    for (const [target, sources] of [...this.draftRenamedFrom]) {
      if (target === newPath) {
        this.draftRenamedFrom.delete(target);
        continue;
      }
      const kept = sources.filter((src) => src !== newPath);
      if (kept.length === 0) this.draftRenamedFrom.delete(target);
      else if (kept.length !== sources.length) this.draftRenamedFrom.set(target, kept);
    }
    if (combined.length > 0) {
      this.draftRenamedFrom.set(newPath, combined);
      capMap(this.draftRenamedFrom, MAX_REMOVED);
    }
    this.dirty = true;
  }

  recordDraftRename(oldPath: string, newPath: string): void {
    this.applyDraftRename(oldPath, newPath);
    this.save();
  }

  clearDraftRenamesFrom(oldPath: string): void {
    let changed = this.retiredDraftSources.delete(oldPath);
    for (const [target, sources] of [...this.draftRenamedFrom]) {
      const kept = sources.filter((src) => src !== oldPath);
      if (kept.length === 0) {
        this.draftRenamedFrom.delete(target);
        changed = true;
      } else if (kept.length !== sources.length) {
        this.draftRenamedFrom.set(target, kept);
        changed = true;
      }
    }
    if (!changed) return;
    this.dirty = true;
    this.save();
  }

  draftRenameSources(newPath: string): readonly string[] {
    return this.draftRenamedFrom.get(newPath) ?? [];
  }

  draftRenameSource(newPath: string): string | null {
    const list = this.draftRenamedFrom.get(newPath);
    return list && list.length > 0 ? list[0]! : null;
  }

  draftRenameTargets(): ReadonlyMap<string, readonly string[]> {
    return this.draftRenamedFrom;
  }

  retireDraftSource(oldPath: string): void {
    if (oldPath === "" || this.entries.has(oldPath)) return;
    this.retiredDraftSources.delete(oldPath);
    this.retiredDraftSources.set(oldPath, this.now());
    capMap(this.retiredDraftSources, MAX_REMOVED);
    this.dirty = true;
    this.save();
  }

  retiredSources(): ReadonlyMap<string, number> {
    return this.retiredDraftSources;
  }

  noteAbandonedDraft(path: string): void {
    if (path === "") return;
    this.recentlyAbandonedDrafts.delete(path);
    this.recentlyAbandonedDrafts.set(path, this.now());
    capMap(this.recentlyAbandonedDrafts, MAX_REMOVED);
    this.dirty = true;
    this.save();
  }

  wasRecentlyAbandonedDraft(path: string): boolean {
    const at = this.recentlyAbandonedDrafts.get(path);
    if (at === undefined) return false;
    if (this.now() - at < REVIEW_TOMBSTONE_TTL_MS) return true;
    this.recentlyAbandonedDrafts.delete(path);
    this.dirty = true;
    return false;
  }

  noteUnflushedLiveDelete(path: string, sha: string): void {
    if (path === "" || sha === "" || this.entries.has(path)) return;
    this.unflushedLiveDeletes.delete(path);
    this.unflushedLiveDeletes.set(path, { sha, at: this.now() });
    capMap(this.unflushedLiveDeletes, MAX_REMOVED);
    this.dirty = true;
    this.save();
  }

  clearUnflushedLiveDelete(path: string): boolean {
    if (!this.unflushedLiveDeletes.delete(path)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  unflushedLiveDeleted(): ReadonlyMap<string, { sha: string; at: number }> {
    return this.unflushedLiveDeletes;
  }

  isSupersededDraftSource(oldPath: string): boolean {
    for (const sources of this.draftRenamedFrom.values()) if (sources.includes(oldPath)) return true;
    const retiredAt = this.retiredDraftSources.get(oldPath);
    if (retiredAt === undefined) return false;
    if (!this.entries.has(oldPath) && this.now() - retiredAt < RETIRED_DRAFT_TTL_MS) return true;
    this.retiredDraftSources.delete(oldPath);
    this.dirty = true;
    return false;
  }

  forgetDraftRenameSource(newPath: string, oldPath: string): boolean {
    const list = this.draftRenamedFrom.get(newPath);
    if (!list) return false;
    const kept = list.filter((src) => src !== oldPath);
    if (kept.length === list.length) return false;
    if (kept.length === 0) this.draftRenamedFrom.delete(newPath);
    else this.draftRenamedFrom.set(newPath, kept);
    this.dirty = true;
    this.save();
    return true;
  }

  forgetDraftRename(newPath: string): boolean {
    if (!this.draftRenamedFrom.delete(newPath)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  queueDraftDelete(path: string): void {
    if (path === "" || this.isSupersededDraftSource(path) || this.pendingDraftDeletes.has(path)) return;
    this.pendingDraftDeletes.add(path);
    this.dirty = true;
    this.save();
  }

  finishDraftDelete(path: string): boolean {
    if (!this.pendingDraftDeletes.delete(path)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  hasPendingDraftDelete(path: string): boolean {
    return this.pendingDraftDeletes.has(path);
  }

  draftDeletes(): ReadonlySet<string> {
    return this.pendingDraftDeletes;
  }

  matched(path: string, sha: string): void {
    const entry = this.entries.get(path);
    if (entry?.sha !== sha || (entry.base === sha && !entry.localOnly)) return;
    const { localOnly: _local, ...rest } = entry;
    this.entries.set(path, { ...rest, base: sha });
    this.dirty = true;
  }

  rebased(path: string, sha: string): void {
    const entry = this.entries.get(path);
    if (!entry || (entry.base === sha && !entry.localOnly)) return;
    const { localOnly: _local, ...rest } = entry;
    this.entries.set(path, { ...rest, base: sha });
    this.dirty = true;
  }

  setLocalOnly(path: string, localOnly: boolean): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    if (localOnly) {
      if (entry.base !== null || entry.sent !== undefined || entry.localOnly) return;
      this.entries.set(path, { ...entry, localOnly: true });
      this.dirty = true;
      return;
    }
    if (!entry.localOnly) return;
    const { localOnly: _local, ...rest } = entry;
    this.entries.set(path, rest);
    this.dirty = true;
  }

  reconcile(
    repo: ReadonlyMap<string, string>,
    inFlight: ReadonlySet<string>,
    draftsKnown: boolean,
    rawInFlight?: ReadonlySet<string>,
    closingDeletes = false,
  ): void {
    for (const [path, entry] of this.entries) {
      const repoSha = repo.get(path);
      if (repoSha === entry.sha) this.matched(path, entry.sha);
      else if (repoSha !== undefined && entry.same === repoSha) this.rebased(path, repoSha);
      else if (repoSha !== undefined || inFlight.has(path)) this.setLocalOnly(path, false);
      else if (draftsKnown && entry.base === null && entry.sent === undefined) this.setLocalOnly(path, true);
    }
    for (const [newPath, sources] of [...this.draftRenamedFrom]) {
      const kept = sources.filter((src) => !repo.has(src));
      if (kept.length === 0) {
        this.draftRenamedFrom.delete(newPath);
        this.dirty = true;
      } else if (kept.length !== sources.length) {
        this.draftRenamedFrom.set(newPath, kept);
        this.dirty = true;
      }
    }
    const rawSet = rawInFlight ?? inFlight;
    const now = this.now();
    for (const [path, at] of [...this.retiredDraftSources]) {
      if (repo.has(path) || this.entries.has(path) || now - at >= RETIRED_DRAFT_TTL_MS || (draftsKnown && !rawSet.has(path) && now - at >= RETIRED_DRAFT_SETTLE_MS)) {
        this.retiredDraftSources.delete(path);
        this.dirty = true;
      }
    }
    for (const [path, at] of [...this.recentlyAbandonedDrafts]) {
      if (repo.has(path) || now - at >= REVIEW_TOMBSTONE_TTL_MS) {
        this.recentlyAbandonedDrafts.delete(path);
        this.dirty = true;
      }
    }
    for (const [path, one] of [...this.unflushedLiveDeletes]) {
      if (repo.has(path) || this.entries.has(path) || now - one.at >= RETIRED_DRAFT_SETTLE_MS) {
        this.unflushedLiveDeletes.delete(path);
        this.dirty = true;
      }
    }
    for (const path of [...this.pendingDraftDeletes]) {
      if (repo.has(path) || (!closingDeletes && draftsKnown && !rawSet.has(path))) {
        this.pendingDraftDeletes.delete(path);
        this.dirty = true;
      }
    }
    for (const gone of [...this.removed.values()]) {
      if (gone.localOnly && !this.pendingDraftDeletes.has(gone.path) && draftsKnown && !rawSet.has(gone.path)) {
        this.settled(gone.path);
        continue;
      }
      if (draftsKnown && gone.base === null && !repo.has(gone.path) && !inFlight.has(gone.path) && !this.isSupersededDraftSource(gone.path) && !this.pendingDraftDeletes.has(gone.path)) {
        this.settled(gone.path);
      }
    }
  }

  sentAs(path: string, sha: string | null, to: string | null = null, agreement: { agreed?: string; commit?: string; at?: number } = {}): void {
    if (sha !== null && this.recentlyAbandonedDrafts.delete(path)) this.dirty = true;
    const entry = this.entries.get(path);
    const next: Pick<CacheEntry, "sent" | "sentTo" | "agreed" | "sentCommit" | "sentAt"> =
      sha === null ? {} : { sent: sha, ...(to === null ? {} : { sentTo: to }), ...(agreement.agreed === undefined ? {} : { agreed: agreement.agreed }), ...(agreement.commit === undefined ? {} : { sentCommit: agreement.commit }), ...(agreement.at === undefined ? {} : { sentAt: agreement.at }) };
    if (!entry || (entry.sent === next.sent && entry.sentTo === next.sentTo && entry.agreed === next.agreed && entry.sentCommit === next.sentCommit && entry.sentAt === next.sentAt && (sha === null || !entry.localOnly))) return;
    const { sent: _was, sentTo: _to, agreed: _agreed, sentCommit: _commit, sentAt: _at, localOnly: _local, ...rest } = entry;
    this.entries.set(path, { ...rest, ...(sha === null && entry.localOnly ? { localOnly: true as const } : {}), ...next });
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
    this.dirty = this.removed.delete(path) || this.dirty;
    this.save();
  }

  dropped(path: string): void {
    for (const scanDropped of this.activeScans) scanDropped.add(path);
    const hadEntry = this.entries.delete(path);
    const hadCopied = this.copied.delete(path);
    if (hadEntry || hadCopied) this.dirty = true;
    this.settled(path);
  }
}
