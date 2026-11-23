import type { Activity } from "./activity";
import type { StayGitMark } from "./state";

export interface GitLogEntry {
  from: string;
  to: string;
  message: string;
}

export interface GitPorts {
  log(): Promise<number | null>;
  entries(): Promise<GitLogEntry[]>;
  stash(): Promise<number | null>;
  head?(): Promise<string | null>;
}

export const RELOOK_MS = 60_000;

const WORKS_ON_FILES = /^(checkout|pull|merge|rebase|reset|cherry-pick|revert|am|commit \(merge\))(?=[\s:(]|$)/;

const changedFiles = (entry: GitLogEntry): boolean => WORKS_ON_FILES.test(entry.message) && !(entry.message.startsWith("checkout") && entry.from === entry.to);

export const sameGitMark = (a: StayGitMark | undefined, b: StayGitMark): boolean =>
  a !== undefined && a.head === b.head && a.count === b.count && a.lastTo === b.lastTo && a.stash === b.stash;

export const markOf = (head: string | null, entries: readonly GitLogEntry[], stash: number | null): StayGitMark => ({
  head,
  count: entries.length,
  lastTo: entries.at(-1)?.to ?? null,
  stash,
});

export function gitMovedSince(saved: StayGitMark | undefined, current: StayGitMark, entries: readonly GitLogEntry[]): boolean {
  if (saved === undefined) return false;
  if (current.stash !== saved.stash) return true;
  if (entries.length < saved.count) return true;
  if (saved.count > 0 && entries[saved.count - 1]?.to !== saved.lastTo) return true;
  if (entries.length > saved.count) return entries.slice(saved.count).some(changedFiles);
  return entries.length === 0 && current.head !== saved.head;
}

export interface GitObservation {
  moved: boolean;
  mark: StayGitMark | null;
}

export class GitWatch {
  private ports: GitPorts | null = null;
  private lookedAt = Number.NEGATIVE_INFINITY;
  private seen: number | null | undefined;
  private stashSeen: number | null = null;
  private seenMark: StayGitMark | undefined;

  constructor(
    private readonly locate: () => Promise<GitPorts | null>,
    private readonly activity: Activity,
    private readonly now: () => number = Date.now,
  ) {}

  private async ensurePorts(force: boolean): Promise<GitPorts | null> {
    if (this.ports !== null) return this.ports;
    if (!force && this.now() - this.lookedAt < RELOOK_MS) return null;
    this.lookedAt = this.now();
    this.ports = await this.locate();
    this.seen = undefined;
    this.seenMark = undefined;
    return this.ports;
  }

  async checkSince(saved: StayGitMark | undefined): Promise<GitObservation> {
    const ports = await this.ensurePorts(true);
    if (ports === null) return { moved: false, mark: null };
    const [log, entries, stash, head] = await Promise.all([
      ports.log(),
      ports.entries(),
      ports.stash(),
      ports.head ? ports.head() : Promise.resolve(null),
    ]);
    const mark = markOf(head, entries, stash);
    this.seen = log;
    this.stashSeen = stash;
    this.seenMark = mark;
    return { moved: gitMovedSince(saved, mark, entries), mark };
  }

  async poll(): Promise<GitObservation> {
    const ports = await this.ensurePorts(false);
    if (ports === null) return { moved: false, mark: null };
    const [log, stash] = await Promise.all([ports.log(), ports.stash()]);
    const first = this.seen === undefined;
    const stashed = !first && stash !== this.stashSeen;
    const logged = !first && log !== this.seen;
    this.seen = log;
    this.stashSeen = stash;
    let moved = false;
    let mark: StayGitMark | null = null;
    if (first || logged || stashed) {
      const [entries, head] = await Promise.all([ports.entries(), ports.head ? ports.head() : Promise.resolve(null)]);
      mark = markOf(head, entries, stash);
      moved = first ? false : gitMovedSince(this.seenMark, mark, entries);
      this.seenMark = mark;
    }
    if (moved) this.activity.gitMoved();
    return { moved, mark };
  }
}
