import { type DocumentRef, docKey as keyOf } from "../mapping";
import { type Identity, publishIdentity } from "../presence";
import { Room } from "./room";
import type { TokenSource } from "../token-source";
import type { OpenTransport } from "./transport";

export const LINGER_MS = 15_000;

export const RETRY_AFTER_MS = 5_000;

interface Entry {
  room: Room;
  holders: number;
  closing: number | null;
  lastTried: number;
  noLinger?: boolean;
}

export class RoomPool {
  private static readonly activePools = new Set<RoomPool>();
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly open: OpenTransport,
    private readonly identity: () => Identity,
    private readonly closed: (ref: DocumentRef) => void,
    private readonly tokens: Pick<TokenSource, "askForBridge">,
    private readonly now: () => number = Date.now,
  ) {
    RoomPool.activePools.add(this);
  }

  static dropFor(ref: DocumentRef): void {
    for (const pool of RoomPool.activePools) pool.drop(ref);
  }

  static hasRoomFor(ref: DocumentRef): boolean {
    for (const pool of RoomPool.activePools) if (pool.hasRoom(ref)) return true;
    return false;
  }

  hasRoom(ref: DocumentRef): boolean {
    return this.entries.has(keyOf(ref));
  }

  hasActive(ref: DocumentRef): boolean {
    return (this.entries.get(keyOf(ref))?.holders ?? 0) > 0;
  }

  drop(ref: DocumentRef): void {
    const key = keyOf(ref);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.holders <= 0) {
      if (entry.closing !== null) window.clearTimeout(entry.closing);
      entry.closing = null;
      entry.room.destroy();
      this.entries.delete(key);
      this.closed(entry.room.ref);
      return;
    }
    entry.noLinger = true;
  }

  acquire(ref: DocumentRef): Room {
    const key = keyOf(ref);
    let entry = this.entries.get(key);
    const existing = entry !== undefined;
    if (!entry) {
      entry = { room: this.newRoom(ref), holders: 0, closing: null, lastTried: this.now() };
      this.entries.set(key, entry);
      this.watch(key, entry);
    }
    entry.noLinger = false;
    if (entry.closing !== null) {
      window.clearTimeout(entry.closing);
      entry.closing = null;
    }
    entry.holders++;
    if (existing && entry.room.state === "joining") entry.room.nudgeBridge();
    return entry.room;
  }

  release(room: Room, now = false): void {
    let current = room;
    while (current.successor) current = current.successor;
    const key = keyOf(current.ref);
    const entry = this.entries.get(key);
    if (!entry || entry.room !== current || --entry.holders > 0) return;
    const close = (): void => {
      current.destroy();
      this.entries.delete(key);
      this.closed(room.ref);
    };
    if (now || entry.noLinger === true) close();
    else entry.closing = window.setTimeout(close, LINGER_MS);
  }

  private newRoom(ref: DocumentRef): Room {
    return new Room(ref, this.open, this.identity(), (session) => this.tokens.askForBridge(ref, { session }));
  }

  identityChanged(): void {
    for (const entry of this.entries.values()) publishIdentity(entry.room.awareness, this.identity());
  }

  reset(): void {
    for (const [key, entry] of [...this.entries]) this.replace(key, entry, entry.room);
  }

  retryFailed(gap = RETRY_AFTER_MS): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (now - entry.lastTried < gap) continue;
      if (entry.room.state === "joining") {
        entry.lastTried = now;
        entry.room.nudgeBridge();
        continue;
      }
      if (entry.room.state !== "failed" || entry.room.failureCode === "plugin_outdated" || entry.room.failureCode === "document_deleted") continue;
      entry.lastTried = now;
      entry.room.retry();
    }
  }

  destroy(): void {
    RoomPool.activePools.delete(this);
    for (const entry of this.entries.values()) {
      if (entry.closing !== null) window.clearTimeout(entry.closing);
      entry.room.destroy();
      this.closed(entry.room.ref);
    }
    this.entries.clear();
  }

  private watch(key: string, entry: Entry): void {
    const room = entry.room;
    const stop = room.subscribe(() => {
      if (!room.startOver) return;
      stop();
      void Promise.resolve().then(() => this.replace(key, entry, room));
    });
  }

  private replace(key: string, entry: Entry, old: Room): void {
    if (entry.room !== old || this.entries.get(key) !== entry) return;
    this.closed(old.ref);
    if (entry.holders === 0) {
      if (entry.closing !== null) window.clearTimeout(entry.closing);
      this.entries.delete(key);
    } else {
      entry.room = this.newRoom(old.ref);
      entry.lastTried = this.now();
      this.watch(key, entry);
      old.supersede(entry.room);
    }
    old.destroy();
  }
}
