import { hashText } from "../hash";
import type { Eol } from "./line-endings";

export interface LocalState {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

export interface Base {
  room: string | null;
  doc?: string;
  text: string;
  hash: string;
  eol: Eol;
  lineage: number[];
  at: number;
}

export type BaseRead = { status: "none" } | { status: "found"; base: Base } | { status: "unreadable" };

export interface BaseLimits {
  notes: number;
  chars: number;
  note: number;
}

export const BASE_LIMITS: BaseLimits = { notes: 300, chars: 1_000_000, note: 250_000 };

const INDEX_KEY = "specgit-bases";
const noteKey = (path: string): string => `specgit-base-${hashText(path)}`;

interface Entry {
  path: string;
  size: number;
  git?: true;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function readRecord(value: unknown, path: string): Base | null {
  if (!isObject(value) || value.path !== path) return null;
  const { room, text, hash, eol, lineage, at, doc } = value;
  if ((room !== null && typeof room !== "string") || typeof text !== "string" || typeof hash !== "string" || typeof at !== "number") return null;
  if ((eol !== "lf" && eol !== "crlf") || !Array.isArray(lineage) || !lineage.every((client) => typeof client === "number")) return null;
  if (room === null ? typeof doc !== "string" : doc !== undefined) return null;
  return hashText(text) === hash ? { room, ...(typeof doc === "string" ? { doc } : {}), text, hash, eol, lineage, at } : null;
}

export class BaseStore {
  constructor(
    private readonly state: LocalState,
    private readonly limits: BaseLimits = BASE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  has(path: string): boolean {
    try {
      const stored = this.state.load(noteKey(path));
      return stored !== null && stored !== undefined;
    } catch {
      return true;
    }
  }

  read(path: string): BaseRead {
    let stored: unknown;
    try {
      stored = this.state.load(noteKey(path));
    } catch {
      return { status: "unreadable" };
    }
    if (stored === null || stored === undefined) return { status: "none" };
    const base = readRecord(stored, path);
    if (base) return { status: "found", base };
    this.forget(path);
    return { status: "unreadable" };
  }

  write(path: string, base: Pick<Base, "room" | "doc" | "text" | "eol" | "lineage">): void {
    if (base.text.length > this.limits.note) return this.forget(path);
    const record = { path, ...base, hash: hashText(base.text), at: this.now() };
    const entries = this.entries().filter((entry) => entry.path !== path);
    entries.push({ path, size: base.text.length, ...(base.room === null ? { git: true as const } : {}) });
    const total = (): number => entries.reduce((sum, entry) => sum + entry.size, 0);
    while (entries.length > this.limits.notes || total() > this.limits.chars) this.dropOldest(entries);
    while (entries.some((entry) => entry.path === path) && !this.keep(path, record)) this.dropOldest(entries);
    this.saveEntries(entries);
  }

  move(from: string, to: string): void {
    const read = this.read(from);
    if (read.status !== "found") return;
    this.forget(from);
    this.write(to, read.base);
  }

  forget(path: string): void {
    this.clear(path);
    this.saveEntries(this.entries().filter((entry) => entry.path !== path));
  }

  private clear(path: string): void {
    try {
      this.state.save(noteKey(path), null);
    } catch {
      void 0;
    }
  }

  private dropOldest(entries: Entry[]): string | undefined {
    const [oldest] = entries.splice(Math.max(entries.findIndex((entry) => entry.git), 0), 1);
    if (oldest) this.clear(oldest.path);
    return oldest?.path;
  }

  private keep(path: string, record: unknown): boolean {
    try {
      this.state.save(noteKey(path), record);
      return true;
    } catch {
      return false;
    }
  }

  private entries(): Entry[] {
    try {
      const stored = this.state.load(INDEX_KEY);
      if (!Array.isArray(stored)) return [];
      return stored.filter((entry): entry is Entry => isObject(entry) && typeof entry.path === "string" && typeof entry.size === "number");
    } catch {
      return [];
    }
  }

  private saveEntries(entries: Entry[]): void {
    try {
      this.state.save(INDEX_KEY, entries);
    } catch {
      void 0;
    }
  }
}
