export const RETIRED_DRAFT_TTL_MS = 5 * 60_000;
export const REVIEW_TOMBSTONE_TTL_MS = 15 * 60_000;
export const RETIRED_DRAFT_SETTLE_MS = 60_000;
export const CLOSED_DRAFT_GRACE_MS = 45_000;

const MAX_LIFECYCLE = 5_000;
const MAX_SNAPSHOT_ENTRIES = 64;
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;

export interface DoomedDraftRef {
  prNumber: number | null;
  branch: string | null;
  sha: string | null;
}

export type ActiveDraftLifecycle =
  | { kind: "superseded"; target: string; doomed: DoomedDraftRef | null; recreated: boolean }
  | { kind: "retired"; at: number; doomed?: DoomedDraftRef | null; inbound?: boolean }
  | {
      kind: "live-delete";
      at: number;
      doomed: DoomedDraftRef | null;
      recreated: boolean;
      armed: boolean;
      liveFlushSha: string | null;
      waitingLiveFlush: boolean;
    };

export interface ClosedDraftGuard {
  branch: string | null;
  prNumber: number | null;
  at: number;
}

export interface PathDraftLifecycle {
  active?: ActiveDraftLifecycle;
  closed?: ClosedDraftGuard;
  tombstoneAt?: number;
}

export interface PersistedDraftLifecycle {
  superseded?: Record<string, { target: string; doomed?: DoomedDraftRef | null; recreated?: boolean }>;
  retired?: Record<string, number>;
  tombstones?: Record<string, number>;
}

export interface LegacyLifecycleFields {
  draftRenames?: unknown;
  retiredDraftSources?: unknown;
  recentlyAbandonedDrafts?: unknown;
}

export interface DoomedDraftInfo {
  kind: "superseded" | "live-delete";
  doomed: DoomedDraftRef | null;
  recreated: boolean;
  armed: boolean;
  target?: string;
  liveFlushSha?: string | null;
}

function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function parseDoomed(raw: unknown): DoomedDraftRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as { prNumber?: unknown; branch?: unknown; sha?: unknown };
  const prNumber = typeof item.prNumber === "number" && Number.isInteger(item.prNumber) && item.prNumber > 0 ? item.prNumber : null;
  const branch = typeof item.branch === "string" && item.branch !== "" ? item.branch : null;
  const sha = typeof item.sha === "string" && item.sha !== "" ? item.sha : null;
  return prNumber === null && branch === null && sha === null ? null : { prNumber, branch, sha };
}

function mergeDoomed(prev: DoomedDraftRef | null | undefined, next: DoomedDraftRef | null | undefined): DoomedDraftRef | null {
  const prNumber = next?.prNumber != null && next.prNumber > 0 ? next.prNumber : (prev?.prNumber ?? null);
  const branch = next?.branch != null && next.branch !== "" ? next.branch : (prev?.branch ?? null);
  const sha = next?.sha != null && next.sha !== "" ? next.sha : (prev?.sha ?? null);
  return prNumber === null && branch === null && sha === null ? null : { prNumber, branch, sha };
}

export function matchesClosedDraftGuard(
  closed: Pick<ClosedDraftGuard, "branch" | "prNumber">,
  one: { branch: string; prNumber?: number | null },
): boolean {
  if (closed.prNumber !== null && closed.prNumber > 0 && typeof one.prNumber === "number" && one.prNumber > 0) {
    return one.prNumber === closed.prNumber;
  }
  if (closed.branch !== null) return one.branch === closed.branch;
  return closed.prNumber === null;
}

export class DraftLifecycleStore {
  private readonly records = new Map<string, PathDraftLifecycle>();

  constructor(private readonly now: () => number = Date.now) {}

  private ensure(path: string): PathDraftLifecycle {
    let record = this.records.get(path);
    if (!record) {
      record = {};
      this.records.set(path, record);
      capMap(this.records, MAX_LIFECYCLE);
    }
    return record;
  }

  private pruneEmpty(path: string): void {
    const record = this.records.get(path);
    if (!record) return;
    if (record.active === undefined && record.closed === undefined && record.tombstoneAt === undefined) {
      this.records.delete(path);
    }
  }

  clearTransient(): void {
    for (const [path, record] of [...this.records]) {
      delete record.closed;
      if (record.active?.kind === "live-delete") delete record.active;
      this.pruneEmpty(path);
    }
  }

  load(raw: unknown, legacy: LegacyLifecycleFields, present: ReadonlySet<string>): void {
    const now = this.now();
    if (typeof raw === "object" && raw !== null) {
      const persisted = raw as PersistedDraftLifecycle;
      for (const [path, entry] of Object.entries((typeof persisted.superseded === "object" && persisted.superseded !== null ? persisted.superseded : {}) as Record<string, unknown>)) {
        if (path === "" || typeof entry !== "object" || entry === null) continue;
        const item = entry as { target?: unknown; doomed?: unknown; recreated?: unknown };
        if (typeof item.target !== "string" || item.target === "" || item.target === path) continue;
        const doomed = parseDoomed(item.doomed);
        const recreated = item.recreated === true || present.has(path);
        if (recreated && doomed === null) continue;
        this.ensure(path).active = { kind: "superseded", target: item.target, doomed, recreated };
      }
      for (const [path, at] of Object.entries((typeof persisted.retired === "object" && persisted.retired !== null ? persisted.retired : {}) as Record<string, unknown>)) {
        if (typeof at === "number" && path !== "" && !present.has(path) && now - at < RETIRED_DRAFT_TTL_MS) {
          const rec = this.ensure(path);
          if (!rec.active) rec.active = { kind: "retired", at };
        }
      }
      for (const [path, at] of Object.entries((typeof persisted.tombstones === "object" && persisted.tombstones !== null ? persisted.tombstones : {}) as Record<string, unknown>)) {
        if (typeof at === "number" && path !== "" && now - at < REVIEW_TOMBSTONE_TTL_MS) {
          this.ensure(path).tombstoneAt = at;
        }
      }
      capMap(this.records, MAX_LIFECYCLE);
      return;
    }
    for (const [newPath, rawOld] of Object.entries((typeof legacy.draftRenames === "object" && legacy.draftRenames !== null ? legacy.draftRenames : {}) as Record<string, unknown>)) {
      const list = typeof rawOld === "string" ? [rawOld] : Array.isArray(rawOld) ? rawOld : [];
      for (const src of list) {
        if (typeof src === "string" && src !== "" && src !== newPath && !present.has(src)) {
          this.ensure(src).active = { kind: "superseded", target: newPath, doomed: null, recreated: false };
        }
      }
    }
    for (const [path, at] of Object.entries((typeof legacy.retiredDraftSources === "object" && legacy.retiredDraftSources !== null ? legacy.retiredDraftSources : {}) as Record<string, unknown>)) {
      if (typeof at === "number" && path !== "" && !present.has(path) && now - at < RETIRED_DRAFT_TTL_MS) {
        const rec = this.ensure(path);
        if (!rec.active) rec.active = { kind: "retired", at };
      }
    }
    for (const [path, at] of Object.entries((typeof legacy.recentlyAbandonedDrafts === "object" && legacy.recentlyAbandonedDrafts !== null ? legacy.recentlyAbandonedDrafts : {}) as Record<string, unknown>)) {
      if (typeof at === "number" && path !== "" && now - at < REVIEW_TOMBSTONE_TTL_MS) {
        this.ensure(path).tombstoneAt = at;
      }
    }
    capMap(this.records, MAX_LIFECYCLE);
  }

  serialize(): PersistedDraftLifecycle | undefined {
    const now = this.now();
    const superseded: NonNullable<PersistedDraftLifecycle["superseded"]> = {};
    const retired: NonNullable<PersistedDraftLifecycle["retired"]> = {};
    const tombstones: NonNullable<PersistedDraftLifecycle["tombstones"]> = {};
    let hasSuperseded = false;
    let hasRetired = false;
    let hasTombstones = false;
    for (const [path, record] of this.records) {
      if (record.active?.kind === "superseded") {
        superseded[path] = {
          target: record.active.target,
          ...(record.active.doomed ? { doomed: record.active.doomed } : {}),
          ...(record.active.recreated ? { recreated: true } : {}),
        };
        hasSuperseded = true;
      } else if (record.active?.kind === "retired" && !record.active.inbound && now - record.active.at < RETIRED_DRAFT_TTL_MS) {
        retired[path] = record.active.at;
        hasRetired = true;
      }
      if (record.tombstoneAt !== undefined && now - record.tombstoneAt < REVIEW_TOMBSTONE_TTL_MS) {
        tombstones[path] = record.tombstoneAt;
        hasTombstones = true;
      }
    }
    if (!hasSuperseded && !hasRetired && !hasTombstones) return undefined;
    return {
      ...(hasSuperseded ? { superseded } : {}),
      ...(hasRetired ? { retired } : {}),
      ...(hasTombstones ? { tombstones } : {}),
    };
  }

  onLocalRename(oldPath: string, newPath: string, doomed: DoomedDraftRef | null = null): boolean {
    if (oldPath === "" || newPath === "" || oldPath === newPath) return false;
    let reclaimedCycle = false;
    for (const [src, record] of [...this.records]) {
      if (record.active?.kind === "superseded" && record.active.target === oldPath) {
        if (src === newPath) {
          delete record.active;
          this.pruneEmpty(src);
          reclaimedCycle = true;
        } else {
          record.active = { ...record.active, target: newPath };
        }
      }
    }
    const dest = this.records.get(newPath);
    if (dest) {
      if (dest.closed && dest.closed.prNumber === null) delete dest.closed;
      if (!reclaimedCycle && dest.active) {
        if (dest.active.kind === "retired") {
          delete dest.active;
        } else if (dest.active.kind === "superseded") {
          if (dest.active.doomed !== null) dest.active = { ...dest.active, recreated: true };
          else delete dest.active;
        } else if (dest.active.kind === "live-delete") {
          if (dest.active.waitingLiveFlush) delete dest.active;
          else dest.active = { ...dest.active, recreated: true, armed: false };
        }
      }
      this.pruneEmpty(newPath);
    }
    const prev = this.records.get(oldPath);
    const prevDoomed = prev?.active?.kind === "superseded" || prev?.active?.kind === "live-delete" ? prev.active.doomed : null;
    const oldRec = this.ensure(oldPath);
    oldRec.active = {
      kind: "superseded",
      target: newPath,
      doomed: mergeDoomed(prevDoomed, doomed),
      recreated: false,
    };
    return true;
  }

  onLocalCreate(path: string): { changed: boolean; disarmedLiveDelete: boolean } {
    const record = this.records.get(path);
    if (!record) return { changed: false, disarmedLiveDelete: false };
    let changed = false;
    let disarmedLiveDelete = false;
    if (record.closed && record.closed.prNumber === null) {
      delete record.closed;
      changed = true;
    }
    const active = record.active;
    if (active?.kind === "retired") {
      delete record.active;
      changed = true;
    } else if (active?.kind === "superseded") {
      if (!active.recreated) {
        record.active = { ...active, recreated: true };
        changed = true;
      }
    } else if (active?.kind === "live-delete") {
      if (active.armed) disarmedLiveDelete = true;
      if (active.waitingLiveFlush) {
        delete record.active;
        changed = true;
      } else if (!active.recreated || active.armed) {
        record.active = { ...active, recreated: true, armed: false };
        changed = true;
      }
    }
    this.pruneEmpty(path);
    return { changed, disarmedLiveDelete };
  }

  onLiveDelete(
    path: string,
    doomed: DoomedDraftRef | null,
    options: { armed: boolean; liveFlushSha: string | null },
  ): boolean {
    if (path === "") return false;
    const rec = this.ensure(path);
    const prev = rec.active;
    if (prev?.kind === "superseded" && !prev.recreated) return false;
    const prevDoomed = prev?.kind === "live-delete" || prev?.kind === "superseded" ? prev.doomed : null;
    rec.active = {
      kind: "live-delete",
      at: prev?.kind === "live-delete" ? prev.at : this.now(),
      doomed: mergeDoomed(prevDoomed, doomed),
      recreated: false,
      armed: options.armed,
      liveFlushSha: options.liveFlushSha ?? (prev?.kind === "live-delete" ? prev.liveFlushSha : null),
      waitingLiveFlush: false,
    };
    return true;
  }

  updateDoomed(path: string, doomed: DoomedDraftRef): boolean {
    const record = this.records.get(path);
    if (!record?.active) return false;
    if (record.active.kind !== "live-delete" && record.active.kind !== "superseded") return false;
    const merged = mergeDoomed(record.active.doomed, doomed);
    if (
      merged?.prNumber === record.active.doomed?.prNumber &&
      merged?.branch === record.active.doomed?.branch &&
      merged?.sha === record.active.doomed?.sha
    ) {
      return false;
    }
    record.active = { ...record.active, doomed: merged };
    return true;
  }

  disarmLiveDelete(path: string): boolean {
    const record = this.records.get(path);
    if (record?.active?.kind !== "live-delete" || !record.active.armed) return false;
    record.active = { ...record.active, armed: false };
    return true;
  }

  cancelLiveDelete(path: string): boolean {
    const record = this.records.get(path);
    if (record?.active?.kind !== "live-delete") return false;
    delete record.active;
    this.pruneEmpty(path);
    return true;
  }

  markWaitingLiveFlush(path: string): boolean {
    const record = this.records.get(path);
    if (record?.active?.kind !== "live-delete" || record.active.liveFlushSha === null || record.active.recreated) return false;
    record.active = { ...record.active, armed: false, waitingLiveFlush: true, at: this.now() };
    return true;
  }

  promoteLiveFlush(path: string, doomed: DoomedDraftRef | null): boolean {
    const record = this.records.get(path);
    if (record?.active?.kind !== "live-delete" || !record.active.waitingLiveFlush) return false;
    record.active = {
      ...record.active,
      waitingLiveFlush: false,
      armed: false,
      liveFlushSha: null,
      doomed: mergeDoomed(record.active.doomed, doomed),
    };
    return true;
  }

  retireSource(path: string, isPresent: boolean, doomed: DoomedDraftRef | null = null, inbound = false): boolean {
    if (path === "") return false;
    if (isPresent) return this.clearActive(path);
    const rec = this.ensure(path);
    rec.active = { kind: "retired", at: this.now(), ...(doomed ? { doomed } : {}), ...(inbound ? { inbound: true } : {}) };
    return true;
  }

  clearActive(path: string): boolean {
    const record = this.records.get(path);
    if (!record || record.active === undefined) return false;
    delete record.active;
    this.pruneEmpty(path);
    return true;
  }

  forgetSupersededFor(target: string, oldPath?: string): boolean {
    let changed = false;
    for (const [src, record] of [...this.records]) {
      if (record.active?.kind === "superseded" && record.active.target === target && (oldPath === undefined || src === oldPath)) {
        delete record.active;
        this.pruneEmpty(src);
        changed = true;
      }
    }
    return changed;
  }

  noteClosed(path: string, branch: string | null, prNumber: number | null): boolean {
    if (path === "" || (branch === null && prNumber === null)) return false;
    const now = this.now();
    const rec = this.ensure(path);
    rec.closed = { branch, prNumber, at: now };
    rec.tombstoneAt = now;
    return true;
  }

  noteAbandonedTombstone(path: string): boolean {
    if (path === "") return false;
    this.ensure(path).tombstoneAt = this.now();
    return true;
  }

  onLearnedOpenPr(path: string, prNumber: number): void {
    const record = this.records.get(path);
    if (!record?.closed) return;
    if (record.closed.prNumber === null || record.closed.prNumber !== prNumber) {
      delete record.closed;
      this.pruneEmpty(path);
    }
  }

  onSent(path: string, to: string | null = null): boolean {
    const record = this.records.get(path);
    if (!record || record.tombstoneAt === undefined) return false;
    if (record.closed?.prNumber != null && to === `pr:${record.closed.prNumber}`) return false;
    delete record.tombstoneAt;
    this.pruneEmpty(path);
    return true;
  }

  onScan(present: ReadonlySet<string>, scanRenamedTargets: ReadonlySet<string>, scanDropped: ReadonlySet<string>): boolean {
    const now = this.now();
    let changed = false;
    for (const [path, record] of [...this.records]) {
      const active = record.active;
      if (active?.kind === "superseded") {
        const targetRecord = this.records.get(active.target);
        const targetIsLiveDelete = targetRecord?.active?.kind === "live-delete";
        if (!present.has(active.target) && !scanRenamedTargets.has(active.target) && !scanDropped.has(active.target) && !targetIsLiveDelete && !active.recreated) {
          delete record.active;
          changed = true;
        } else if (present.has(path) && !active.recreated) {
          if (active.doomed !== null) {
            record.active = { ...active, recreated: true };
            changed = true;
          } else {
            delete record.active;
            changed = true;
          }
        }
      } else if (active?.kind === "retired") {
        if (present.has(path) || now - active.at >= RETIRED_DRAFT_TTL_MS) {
          delete record.active;
          changed = true;
        }
      } else if (active?.kind === "live-delete" && active.waitingLiveFlush) {
        if (present.has(path) || now - active.at >= RETIRED_DRAFT_SETTLE_MS) {
          delete record.active;
          changed = true;
        }
      }
      if (record.tombstoneAt !== undefined && now - record.tombstoneAt >= REVIEW_TOMBSTONE_TTL_MS) {
        delete record.tombstoneAt;
        changed = true;
      }
      this.pruneEmpty(path);
    }
    return changed;
  }

  onReconcile(
    repo: ReadonlyMap<string, string>,
    present: ReadonlySet<string>,
    rawInFlight: ReadonlySet<string>,
    draftsKnown: boolean,
    closingDeletes: boolean,
  ): boolean {
    const now = this.now();
    let changed = false;
    for (const [path, record] of [...this.records]) {
      const onRepo = repo.has(path);
      const active = record.active;
      if (active?.kind === "superseded") {
        if (onRepo) {
          delete record.active;
          changed = true;
        }
      } else if (active?.kind === "retired") {
        if (onRepo || present.has(path) || now - active.at >= RETIRED_DRAFT_TTL_MS || (draftsKnown && !rawInFlight.has(path) && now - active.at >= RETIRED_DRAFT_SETTLE_MS)) {
          delete record.active;
          changed = true;
        }
      } else if (active?.kind === "live-delete") {
        if (onRepo) {
          delete record.active;
          changed = true;
        } else if (active.waitingLiveFlush) {
          if (present.has(path) || now - active.at >= RETIRED_DRAFT_SETTLE_MS) {
            delete record.active;
            changed = true;
          }
        } else if (!active.armed && !closingDeletes && draftsKnown && !rawInFlight.has(path)) {
          delete record.active;
          changed = true;
        }
      }
      if (record.tombstoneAt !== undefined && (onRepo || now - record.tombstoneAt >= REVIEW_TOMBSTONE_TTL_MS)) {
        delete record.tombstoneAt;
        changed = true;
      }
      this.pruneEmpty(path);
    }
    return changed;
  }

  isSupersededSource(path: string, isPresent: boolean): boolean {
    const active = this.records.get(path)?.active;
    if (!active) return false;
    if (active.kind === "superseded") return !active.recreated;
    if (active.kind === "retired") {
      if (active.inbound) return false;
      if (!isPresent && this.now() - active.at < RETIRED_DRAFT_TTL_MS) return true;
      delete this.records.get(path)!.active;
      this.pruneEmpty(path);
    }
    return false;
  }

  supersededSourcesFor(target: string): string[] {
    const list: string[] = [];
    for (const [src, record] of this.records) {
      if (record.active?.kind === "superseded" && record.active.target === target) list.push(src);
    }
    return list;
  }

  supersededTargets(): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const [src, record] of this.records) {
      if (record.active?.kind !== "superseded") continue;
      const list = grouped.get(record.active.target);
      if (list) list.push(src);
      else grouped.set(record.active.target, [src]);
    }
    return grouped;
  }

  retiredSources(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [path, record] of this.records) {
      if (record.active?.kind === "retired" && !record.active.inbound) out.set(path, record.active.at);
    }
    return out;
  }

  doomedFor(path: string): DoomedDraftInfo | null {
    const active = this.records.get(path)?.active;
    if (!active) return null;
    if (active.kind === "superseded") {
      return { kind: "superseded", doomed: active.doomed, recreated: active.recreated, armed: false, target: active.target };
    }
    if (active.kind === "live-delete" && !active.waitingLiveFlush) {
      return {
        kind: "live-delete",
        doomed: active.doomed,
        recreated: active.recreated,
        armed: active.armed,
        liveFlushSha: active.liveFlushSha,
      };
    }
    return null;
  }

  hasPendingLiveDelete(path: string): boolean {
    const active = this.records.get(path)?.active;
    return active?.kind === "live-delete" && !active.waitingLiveFlush;
  }

  pendingLiveDeletes(readyOnly = false): Set<string> {
    const out = new Set<string>();
    for (const [path, record] of this.records) {
      if (record.active?.kind === "live-delete" && !record.active.waitingLiveFlush && (!readyOnly || !record.active.armed)) {
        out.add(path);
      }
    }
    return out;
  }

  waitingLiveFlushes(): Map<string, { sha: string; at: number }> {
    const out = new Map<string, { sha: string; at: number }>();
    for (const [path, record] of this.records) {
      if (record.active?.kind === "live-delete" && record.active.waitingLiveFlush && record.active.liveFlushSha !== null) {
        out.set(path, { sha: record.active.liveFlushSha, at: record.active.at });
      }
    }
    return out;
  }

  closedGuards(): Map<string, ClosedDraftGuard> {
    const now = this.now();
    const out = new Map<string, ClosedDraftGuard>();
    for (const [path, record] of [...this.records]) {
      if (!record.closed) continue;
      if (now - record.closed.at >= CLOSED_DRAFT_GRACE_MS) {
        delete record.closed;
        this.pruneEmpty(path);
        continue;
      }
      out.set(path, record.closed);
    }
    return out;
  }

  deleteClosedGuard(path: string): void {
    const record = this.records.get(path);
    if (!record?.closed) return;
    delete record.closed;
    this.pruneEmpty(path);
  }

  wasRecentlyClosed(path: string): boolean {
    const record = this.records.get(path);
    if (!record) return false;
    const now = this.now();
    if (record.closed !== undefined) {
      if (now - record.closed.at < CLOSED_DRAFT_GRACE_MS) return true;
      delete record.closed;
    }
    if (record.tombstoneAt !== undefined) {
      if (now - record.tombstoneAt < REVIEW_TOMBSTONE_TTL_MS) return true;
      delete record.tombstoneAt;
    }
    this.pruneEmpty(path);
    return false;
  }

  entries(): ReadonlyMap<string, PathDraftLifecycle> {
    return this.records;
  }
}

export class DraftTextSnapshots {
  private readonly items = new Map<string, string>();
  private totalBytes = 0;

  remember(path: string, text: string): void {
    if (path === "" || text.length > MAX_SNAPSHOT_FILE_BYTES) return;
    const prev = this.items.get(path);
    if (prev !== undefined) {
      this.totalBytes -= prev.length;
      this.items.delete(path);
    }
    this.items.set(path, text);
    this.totalBytes += text.length;
    while (this.items.size > MAX_SNAPSHOT_ENTRIES || this.totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.totalBytes -= this.items.get(oldest)!.length;
      this.items.delete(oldest);
    }
  }

  get(path: string): string | null {
    return this.items.get(path) ?? null;
  }

  take(path: string): string | null {
    const text = this.items.get(path) ?? null;
    this.forget(path);
    return text;
  }

  forget(path: string): void {
    const prev = this.items.get(path);
    if (prev === undefined) return;
    this.totalBytes -= prev.length;
    this.items.delete(path);
  }

  rename(from: string, to: string): void {
    const text = this.take(from);
    if (text !== null) this.remember(to, text);
  }

  clear(): void {
    this.items.clear();
    this.totalBytes = 0;
  }
}
