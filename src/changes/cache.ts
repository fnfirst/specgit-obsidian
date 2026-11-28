import type { LocalState } from "../disk/bases";
import { hashText } from "../hash";
import { gitBlobSha } from "./blob-sha";
import {
  DraftLifecycleStore,
  DraftTextSnapshots,
  RETIRED_DRAFT_SETTLE_MS,
  RETIRED_DRAFT_TTL_MS,
  REVIEW_TOMBSTONE_TTL_MS,
  type DoomedDraftInfo,
  type DoomedDraftRef,
} from "./draft-lifecycle-store";

export { RETIRED_DRAFT_SETTLE_MS, RETIRED_DRAFT_TTL_MS, REVIEW_TOMBSTONE_TTL_MS };

const utf8Decoder = new TextDecoder("utf-8");

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
  readonly lifecycle: DraftLifecycleStore;
  readonly snapshots = new DraftTextSnapshots();
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
    this.lifecycle = new DraftLifecycleStore(this.now);
    this.load();
  }

  private load(): void {
    try {
      const stored = this.state.load(this.key);
      const record =
        typeof stored === "object" && stored !== null
          ? (stored as { files?: unknown; removed?: unknown; foreign?: unknown; copied?: unknown; draftLifecycle?: unknown; draftRenames?: unknown; retiredDraftSources?: unknown; recentlyAbandonedDrafts?: unknown })
          : {};
      for (const [path, kept] of Object.entries((typeof record.copied === "object" && record.copied !== null ? record.copied : {}) as Record<string, unknown>)) {
        if (Array.isArray(kept) && typeof kept[0] === "string" && typeof kept[1] === "number") this.copied.set(path, { sha: kept[0], at: kept[1] });
      }
      for (const [path, entry] of Object.entries((record.files ?? {}) as Record<string, unknown>)) if (isEntry(entry)) this.entries.set(path, entry);
      for (const [path, sha] of Object.entries((typeof record.foreign === "object" && record.foreign !== null ? record.foreign : {}) as Record<string, unknown>)) if (typeof sha === "string") this.foreign.set(path, sha);
      this.lifecycle.load(record.draftLifecycle, record, new Set(this.entries.keys()));
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
      const draftLifecycle = this.lifecycle.serialize();
      this.state.save(this.key, {
        files: Object.fromEntries(this.entries),
        removed: [...this.removed.values()],
        ...(this.foreign.size > 0 ? { foreign: Object.fromEntries(this.foreign) } : {}),
        ...(this.copied.size > 0 ? { copied: Object.fromEntries([...this.copied].map(([path, one]) => [path, [one.sha, one.at]])) } : {}),
        ...(draftLifecycle ? { draftLifecycle } : {}),
      });
      this.dirty = false;
    } catch {
      void 0;
    }
  }

  get(path: string): CacheEntry | undefined {
    return this.entries.get(path);
  }

  restoreEntry(path: string, entry: CacheEntry): void {
    this.entries.set(path, { ...entry });
    this.removed.delete(path);
    this.dirty = true;
    this.save();
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
          if (base === null) this.snapshots.remember(file.path, utf8Decoder.decode(bytes));
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
        const lost: Gone = { path, sha: entry.sha, base: entry.base, ...(isLocalOnly ? { localOnly: true as const } : {}) };
        this.removed.delete(path);
        this.removed.set(path, lost);
        gone.push(lost);
      }
      if (this.lifecycle.onScan(present, scanRenamedTargets, scanDropped)) this.dirty = true;
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

  recordDraftRename(oldPath: string, newPath: string, doomed: DoomedDraftRef | null = null): void {
    if (oldPath === newPath) return;
    for (const scanDropped of this.activeScans) scanDropped.add(oldPath);
    for (const scanRenamedTargets of this.activeRenameTargets) scanRenamedTargets.add(newPath);
    this.snapshots.rename(oldPath, newPath);
    if (this.lifecycle.onLocalRename(oldPath, newPath, doomed)) {
      this.dirty = true;
      this.save();
    }
  }

  onLocalCreate(path: string): { changed: boolean; disarmedLiveDelete: boolean } {
    const res = this.lifecycle.onLocalCreate(path);
    if (res.changed) {
      this.dirty = true;
      this.save();
    }
    return res;
  }

  noteLiveDelete(path: string, doomed: DoomedDraftRef | null, options: { armed: boolean; liveFlushSha: string | null }): boolean {
    const changed = this.lifecycle.onLiveDelete(path, doomed, options);
    if (changed) {
      this.dirty = true;
      this.save();
    }
    return changed;
  }

  updateDoomed(path: string, doomed: DoomedDraftRef): boolean {
    if (!this.lifecycle.updateDoomed(path, doomed)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  disarmLiveDelete(path: string): boolean {
    if (!this.lifecycle.disarmLiveDelete(path)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  cancelLiveDelete(path: string): boolean {
    if (!this.lifecycle.cancelLiveDelete(path)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  markWaitingLiveFlush(path: string): boolean {
    if (!this.lifecycle.markWaitingLiveFlush(path)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  promoteLiveFlush(path: string, doomed: DoomedDraftRef | null): boolean {
    if (!this.lifecycle.promoteLiveFlush(path, doomed)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  clearActiveLifecycle(path: string): boolean {
    if (!this.lifecycle.clearActive(path)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  draftRenameSources(newPath: string): readonly string[] {
    return this.lifecycle.supersededSourcesFor(newPath);
  }

  draftRenameSource(newPath: string): string | null {
    return this.lifecycle.supersededSourcesFor(newPath)[0] ?? null;
  }

  draftRenameTargets(): ReadonlyMap<string, readonly string[]> {
    return this.lifecycle.supersededTargets();
  }

  retireDraftSource(oldPath: string, doomed: DoomedDraftRef | null = null, inbound = false): void {
    if (this.lifecycle.retireSource(oldPath, this.entries.has(oldPath), doomed, inbound)) {
      if (!inbound) {
        this.dirty = true;
        this.save();
      }
    }
  }

  retiredSources(): ReadonlyMap<string, number> {
    return this.lifecycle.retiredSources();
  }

  noteClosedDraft(path: string, branch: string | null, prNumber: number | null): void {
    if (this.lifecycle.noteClosed(path, branch, prNumber)) {
      this.dirty = true;
      this.save();
    }
  }

  noteAbandonedDraft(path: string): void {
    if (this.lifecycle.noteAbandonedTombstone(path)) {
      this.dirty = true;
      this.save();
    }
  }

  wasRecentlyAbandonedDraft(path: string): boolean {
    return this.lifecycle.wasRecentlyClosed(path);
  }

  isSupersededDraftSource(oldPath: string): boolean {
    return this.lifecycle.isSupersededSource(oldPath, this.entries.has(oldPath));
  }

  forgetDraftRenameSource(newPath: string, oldPath: string): boolean {
    if (!this.lifecycle.forgetSupersededFor(newPath, oldPath)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  forgetDraftRename(newPath: string): boolean {
    if (!this.lifecycle.forgetSupersededFor(newPath)) return false;
    this.dirty = true;
    this.save();
    return true;
  }

  doomedFor(path: string): DoomedDraftInfo | null {
    return this.lifecycle.doomedFor(path);
  }

  hasPendingDraftDelete(path: string): boolean {
    return this.lifecycle.hasPendingLiveDelete(path);
  }

  draftDeletes(readyOnly = false): ReadonlySet<string> {
    return this.lifecycle.pendingLiveDeletes(readyOnly);
  }

  waitingLiveFlushes(): ReadonlyMap<string, { sha: string; at: number }> {
    return this.lifecycle.waitingLiveFlushes();
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
    const rawSet = rawInFlight ?? inFlight;
    if (this.lifecycle.onReconcile(repo, new Set(this.entries.keys()), rawSet, draftsKnown, closingDeletes)) {
      this.dirty = true;
    }
    for (const gone of [...this.removed.values()]) {
      if (gone.localOnly && !this.lifecycle.hasPendingLiveDelete(gone.path) && draftsKnown && !rawSet.has(gone.path)) {
        this.settled(gone.path);
        continue;
      }
      if (draftsKnown && gone.base === null && !repo.has(gone.path) && !inFlight.has(gone.path) && !this.isSupersededDraftSource(gone.path) && !this.lifecycle.hasPendingLiveDelete(gone.path)) {
        this.settled(gone.path);
      }
    }
  }

  sentAs(path: string, sha: string | null, to: string | null = null, agreement: { agreed?: string; commit?: string; at?: number } = {}): void {
    if (sha !== null && this.lifecycle.onSent(path, to)) this.dirty = true;
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
    this.snapshots.forget(path);
    if (hadEntry || hadCopied) this.dirty = true;
    this.settled(path);
  }
}
