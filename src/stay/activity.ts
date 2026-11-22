export interface ActivityOptions {
  quietMs: number;
  flurry: number;
  flurryMs: number;
  ownMs: number;
  suspectMs: number;
  gitLookbackMs: number;
  slowFiles: number;
  slowMs: number;
  pendingMs: number;
}

export const ACTIVITY: ActivityOptions = { quietMs: 8_000, flurry: 8, flurryMs: 1_500, ownMs: 5_000, suspectMs: 10 * 60_000, gitLookbackMs: 15_000, slowFiles: 8, slowMs: 60_000, pendingMs: 60_000 };

export class Activity {
  private last = Number.NEGATIVE_INFINITY;
  private recent: Array<{ at: number; path: string }> = [];
  private flurryEnds = 0;
  private gitEnds = 0;
  private history: Array<{ at: number; path: string }> = [];
  private readonly suspect = new Map<string, number>();
  private readonly git = new Map<string, number>();
  private readonly own = new Map<string, number>();
  private readonly ownAt = new Map<string, number>();
  private readonly wrote = new Map<string, { sha: string; at: number }>();
  private readonly pending = new Map<string, Map<number, number>>();
  private writes = 0;
  listener: ((path: string) => void) | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: ActivityOptions = ACTIVITY,
  ) {}

  ownWrite(...paths: string[]): void {
    const until = this.now() + this.options.ownMs;
    for (const path of paths) {
      this.own.set(path, until);
      this.ownAt.set(path, this.now());
    }
  }

  changedByPersonSince(path: string, since: number, mtime: number, typedAt: number | undefined, sha?: string): boolean {
    if (this.isSuspect(path)) return false;
    const left = this.wrote.get(path);
    if (left !== undefined && sha !== undefined) return sha !== left.sha && mtime > since;
    if (mtime <= since) return false;
    const own = this.ownAt.get(path);
    if (own === undefined || own <= since) return true;
    return (typedAt !== undefined && typedAt > own) || mtime > own + this.options.ownMs;
  }

  async during<T>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null): Promise<T> {
    const id = this.writes++;
    const began = this.now();
    for (const path of paths) this.pending.set(path, new Map(this.pending.get(path)).set(id, began));
    let happened = left === undefined;
    try {
      const result = await run();
      const shas = left?.(result) ?? null;
      if (left !== undefined) happened = shas !== null;
      if (shas) for (const [path, sha] of Object.entries(shas)) this.wrote.set(path, { sha, at: this.now() });
      return result;
    } finally {
      const now = this.now();
      for (const path of paths) {
        const rest = new Map(this.pending.get(path));
        rest.delete(id);
        if (rest.size > 0) this.pending.set(path, rest);
        else this.pending.delete(path);
        if (!happened) continue;
        this.ownAt.set(path, now);
        this.own.set(path, Math.max(this.own.get(path) ?? 0, now + this.options.ownMs));
      }
    }
  }

  private writing(path: string): boolean {
    const now = this.now();
    for (const began of this.pending.get(path)?.values() ?? []) if (now - began < this.options.pendingMs) return true;
    return false;
  }

  notWritten(...paths: string[]): void {
    for (const path of paths) {
      this.own.delete(path);
      this.ownAt.delete(path);
    }
  }

  touched(path: string): void {
    const now = this.now();
    if ((this.own.get(path) ?? 0) > now || this.writing(path)) {
      this.ownAt.set(path, now);
      return;
    }
    this.own.delete(path);
    this.last = now;
    const cutoff = now - this.options.flurryMs;
    this.recent = this.recent.filter((event) => event.at > cutoff);
    this.recent.push({ at: now, path });
    this.history = this.history.filter((event) => event.at > now - Math.max(this.options.gitLookbackMs, this.options.slowMs));
    this.history.push({ at: now, path });
    const slow = new Set(this.history.filter((event) => event.at > now - this.options.slowMs).map((event) => event.path));
    if (slow.size >= this.options.slowFiles) for (const file of slow) this.suspect.set(file, now);
    if (new Set(this.recent.map((event) => event.path)).size >= this.options.flurry) {
      this.flurryEnds = now + this.options.quietMs;
      for (const event of this.recent) this.suspect.set(event.path, now);
    }
    if (now < this.flurryEnds || now < this.gitEnds) this.suspect.set(path, now);
    if (now < this.gitEnds) this.git.set(path, now);
    this.listener?.(path);
  }

  renamed(from: string, to: string): void {
    const now = this.now();
    if ((this.own.get(to) ?? 0) > now || this.writing(to)) {
      this.ownAt.set(to, now);
      return;
    }
    if (from !== to) {
      for (const event of this.recent) if (event.path === from) event.path = to;
      for (const event of this.history) if (event.path === from) event.path = to;
      this.moveMark(this.suspect, from, to);
      this.moveMark(this.git, from, to);
    }
    this.touched(to);
  }

  private moveMark(marks: Map<string, number>, from: string, to: string): void {
    const at = marks.get(from);
    if (at === undefined) return;
    marks.delete(from);
    marks.set(to, Math.max(at, marks.get(to) ?? 0));
  }

  gitMoved(): void {
    const now = this.now();
    this.gitEnds = now + this.options.quietMs;
    for (const event of this.history) {
      if (event.at <= now - this.options.gitLookbackMs) continue;
      this.suspect.set(event.path, now);
      this.git.set(event.path, now);
    }
  }

  isGit(path: string): boolean {
    return this.untilOf(this.git, path) !== null;
  }

  private untilOf(marks: Map<string, number>, path: string): number | null {
    const at = marks.get(path);
    if (at === undefined) return null;
    const until = at + this.options.suspectMs;
    if (until > this.now()) return until;
    marks.delete(path);
    return null;
  }

  quietIn(): number {
    return Math.max(0, this.last + this.options.quietMs - this.now());
  }

  isSuspect(path: string): boolean {
    return this.untilOf(this.suspect, path) !== null;
  }

  suspectUntil(path: string): number | null {
    return this.untilOf(this.suspect, path);
  }

  flurryDeadline(path: string): number {
    return this.suspectUntil(path) ?? this.now() + this.options.suspectMs;
  }

  settled(path: string): void {
    this.suspect.delete(path);
    this.git.delete(path);
  }
}
