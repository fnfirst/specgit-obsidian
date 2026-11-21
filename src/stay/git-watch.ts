import type { Activity } from "./activity";

export interface GitLogEntry {
  from: string;
  to: string;
  message: string;
}

export interface GitPorts {
  log(): Promise<number | null>;
  entries(): Promise<GitLogEntry[]>;
  stash(): Promise<number | null>;
}

export const RELOOK_MS = 60_000;

const WORKS_ON_FILES = /^(checkout|pull|merge|rebase|reset|cherry-pick|revert|am|commit \(merge\))(?=[\s:(]|$)/;

const changedFiles = (entry: GitLogEntry): boolean => WORKS_ON_FILES.test(entry.message) && !(entry.message.startsWith("checkout") && entry.from === entry.to);

export class GitWatch {
  private ports: GitPorts | null = null;
  private lookedAt = Number.NEGATIVE_INFINITY;
  private seen: number | null | undefined;
  private stashSeen: number | null = null;
  private counted = 0;

  constructor(
    private readonly locate: () => Promise<GitPorts | null>,
    private readonly activity: Activity,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(): Promise<boolean> {
    if (this.ports === null) {
      if (this.now() - this.lookedAt < RELOOK_MS) return false;
      this.lookedAt = this.now();
      this.ports = await this.locate();
      this.seen = undefined;
      if (this.ports === null) return false;
    }
    const [log, stash] = await Promise.all([this.ports.log(), this.ports.stash()]);
    const first = this.seen === undefined;
    const stashed = !first && stash !== this.stashSeen;
    const logged = !first && log !== this.seen;
    this.seen = log;
    this.stashSeen = stash;
    let moved = stashed;
    if (first || logged) {
      const entries = await this.ports.entries();
      const fresh = first ? [] : entries.slice(entries.length >= this.counted ? this.counted : entries.length - 1);
      this.counted = entries.length;
      moved ||= fresh.some(changedFiles);
    }
    if (moved) this.activity.gitMoved();
    return moved;
  }
}
