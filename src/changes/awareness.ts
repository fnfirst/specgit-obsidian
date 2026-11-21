import type { GroupOverview, InFlightBranch, StatusUnits } from "../shared/review-flow";
import type { ChangeRow } from "./model";
import type { PresenceRead } from "../review/review-api";
import { type AwareState, awareState } from "./aware";
import { agreedOf, type CacheEntry } from "./cache";

export interface NoteChoice {
  words: string;
  label: string;
  run: () => void;
}

export interface HeldDeletes {
  count: number;
  move: () => void;
}

export interface AwareLine {
  added: number;
}

export const PRESENCE_REUSE_MS = 5_000;

export const OFF_MEMORY_MS = 60 * 60_000;

export interface AwareSources {
  viewer: string | null;
  flight: { paths: Readonly<Record<string, readonly InFlightBranch[]>>; overviews: ReadonlyMap<string, GroupOverview> } | null;
  vaultPath: (path: string) => string;
  documentFor: (path: string) => unknown;
}

export class Awareness {
  private presence: PresenceRead | null = null;
  private files: ReadonlyMap<string, CacheEntry> | null = null;
  private offAt: number | null = null;
  private inflight: Promise<PresenceRead> | null = null;
  private lastRead: { read: PresenceRead; at: number } | null = null;
  private generation = 0;

  constructor(private readonly now: () => number) {}

  reset(): void {
    this.presence = null;
    this.files = null;
    this.offAt = null;
    this.inflight = null;
    this.lastRead = null;
    this.generation += 1;
  }

  scanned(files: ReadonlyMap<string, CacheEntry>): void {
    this.files = files;
  }

  hasFiles(): boolean {
    return this.files !== null;
  }

  hasFile(path: string): boolean {
    return this.files?.has(path) === true;
  }

  rooms(vaultPath: (path: string) => string): ReadonlyMap<string, readonly string[]> {
    const rooms = new Map<string, readonly string[]>();
    if (this.presence?.kind !== "docs") return rooms;
    for (const doc of this.presence.docs) if (doc.people.length > 0) rooms.set(vaultPath(doc.path), doc.people);
    return rooms;
  }

  forgetOff(): void {
    this.offAt = null;
  }

  asleep(): boolean {
    return this.offAt !== null && this.now() - this.offAt < OFF_MEMORY_MS;
  }

  async read(ask: (() => Promise<PresenceRead>) | undefined, fresh = false): Promise<PresenceRead> {
    if (!ask) return { kind: "unknown" };
    if (this.asleep()) return { kind: "off" };
    if (!fresh) {
      if (this.inflight) return this.inflight;
      if (this.lastRead && this.now() - this.lastRead.at < PRESENCE_REUSE_MS) return this.lastRead.read;
    } else if (this.inflight) await this.inflight.catch(() => undefined);
    const generation = this.generation;
    const asked = ask().then(
      (read) => {
        if (read.kind !== "unknown" && generation === this.generation) this.lastRead = { read, at: this.now() };
        return read;
      },
      (): PresenceRead => ({ kind: "unknown" }),
    );
    const mine = asked.finally(() => {
      if (this.inflight === mine) this.inflight = null;
    });
    this.inflight = mine;
    return mine;
  }

  heard(read: PresenceRead): boolean {
    if (read.kind === "unknown") return false;
    this.offAt = read.kind === "off" ? this.now() : null;
    if (JSON.stringify(read) === JSON.stringify(this.presence)) return false;
    this.presence = read;
    return true;
  }

  state(from: AwareSources, kept: AwareState | null): AwareState | null {
    const { flight, files } = { flight: from.flight, files: this.files };
    if (!flight || !files) return kept;
    return awareState({
      viewer: from.viewer,
      paths: flight.paths,
      overviews: flight.overviews,
      presence: this.presence,
      vaultPath: from.vaultPath,
      fileAt: (path) => {
        const file = files.get(path);
        if (!file || from.documentFor(path) === null) return null;
        return { holds: (blob) => file.sha === blob || (file.sent === blob && agreedOf(file) === file.sha) };
      },
    });
  }
}

export function withChoice(was: ReadonlyMap<string, NoteChoice>, path: string, choice: NoteChoice | null): ReadonlyMap<string, NoteChoice> | null {
  if (choice === null ? !was.has(path) : was.get(path)?.words === choice.words && was.get(path)?.label === choice.label) {
    if (choice !== null) (was as Map<string, NoteChoice>).set(path, choice);
    return null;
  }
  const next = new Map(was);
  if (choice === null) next.delete(path);
  else next.set(path, choice);
  return next;
}

export interface LayoutInput {
  aware: AwareState | null;
  loose: readonly ChangeRow[];
  units: StatusUnits;
  line: AwareLine | null;
  live?: (path: string) => boolean;
}

export interface Layout {
  units: StatusUnits;
  progressing: (row: ChangeRow) => boolean;
  changedHere: ChangeRow[];
  progressRows: ReadonlyMap<string, ChangeRow>;
  line: AwareLine | null;
}

export function awareLayout({ aware, loose, units, line, live }: LayoutInput): Layout {
  if (aware === null) return { units, progressing: () => false, changedHere: [], progressRows: new Map(), line: null };
  const progressing = (row: ChangeRow): boolean => aware.settled.has(row.change.path) || row.unchanged === true || live?.(row.change.path) === true;
  const byPath = new Map(loose.map((row) => [row.change.path, row]));
  const boxed = (path: string): boolean => {
    const row = byPath.get(path);
    return row === undefined || !progressing(row) || aware.own.has(path);
  };
  return {
    units: { ...units, loose: units.loose.filter((entry) => boxed(entry.path)) },
    progressing,
    changedHere: loose.filter((row) => !progressing(row)),
    progressRows: new Map(loose.filter(progressing).map((row) => [row.change.path, row])),
    line,
  };
}
