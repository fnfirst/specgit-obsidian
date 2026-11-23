import { ATTACHMENT_HELD, ATTACHMENT_LATER } from "../changes/attachment-memory";
import { WRITES_PER_FILE } from "../changes/burst";
import type { Looked } from "../changes/model";
import type { Activity } from "./activity";
import type { WriteBudget } from "./limits";
import { ATTACHMENTS_KEPT, ATTACHMENTS_PER_NOTE, type StayState } from "./state";
import type { StayPorts } from "./types";
import { ATTACHMENTS_SAID } from "./words";

const ATTACHMENT_BACKOFF_MS = [30_000, 120_000, 600_000];

export interface AttachmentProblem {
  name: string;
  why: string;
  server?: true;
}

export interface AttachmentRetryContext {
  ports: Pick<StayPorts, "retryAttachments" | "hidden" | "personBusy" | "offline" | "now" | "later" | "holdsChanged">;
  state: StayState;
  activity: Activity;
  budget: WriteBudget;
  on(): boolean;
  generation(): number;
  current(generation: number): boolean;
  looked(): Looked | null;
  saveSoon(): void;
}

export class StayAttachments {
  private readonly notes = new Map<string, string>();
  private readonly timers = new Map<string, () => void>();
  private readonly tries = new Map<string, number>();
  private readonly left = new Map<string, ReadonlyArray<AttachmentProblem>>();
  private readonly retrying = new Set<string>();
  private readonly queue: string[] = [];
  private wake: (() => void) | null = null;
  private running = false;
  private readonly reported = new Set<string>();

  constructor(private readonly ctx: AttachmentRetryContext) {}

  stop(): void {
    this.notes.clear();
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.tries.clear();
    this.queue.length = 0;
    this.wake?.();
    this.wake = null;
    this.left.clear();
    this.retrying.clear();
    this.reported.clear();
  }

  note(path: string): string | null {
    return this.notes.get(path) ?? null;
  }

  row(path: string, words: string | null): void {
    const before = this.notes.get(path) ?? null;
    if (words === null) this.notes.delete(path);
    else this.notes.set(path, words);
    if (before !== words) this.ctx.ports.holdsChanged?.();
  }

  restore(): void {
    for (const [path, kept] of Object.entries(this.ctx.state.data.attachments ?? {})) {
      this.tries.set(path, kept.tries);
      this.retrying.add(path);
      this.problems(path, kept.problems.map((one) => ({ ...one })));
      this.retrying.delete(path);
    }
  }

  problems(path: string, problems: ReadonlyArray<AttachmentProblem>): void {
    this.reported.add(path);
    this.timers.get(path)?.();
    this.timers.delete(path);
    if (!this.retrying.has(path)) this.tries.delete(path);
    if (problems.length === 0) {
      const had = this.notes.delete(path);
      this.tries.delete(path);
      this.left.delete(path);
      this.keep(path);
      if (had) this.ctx.ports.holdsChanged?.();
      return;
    }
    this.left.set(path, problems);
    this.keep(path);
    const later = problems.some((one) => one.why === ATTACHMENT_LATER);
    const tried = this.tries.get(path) ?? 0;
    if (later && tried >= ATTACHMENT_BACKOFF_MS.length) {
      this.notes.set(path, ATTACHMENTS_SAID(problems.map((one) => (one.why === ATTACHMENT_LATER ? { ...one, why: ATTACHMENT_HELD } : one))));
      this.ctx.ports.holdsChanged?.();
      return;
    }
    this.notes.set(path, ATTACHMENTS_SAID(problems));
    this.ctx.ports.holdsChanged?.();
    if (later && this.ctx.on()) this.timers.set(path, this.ctx.ports.later(() => this.enqueue(path, this.ctx.generation()), ATTACHMENT_BACKOFF_MS[tried]!));
  }

  private keep(path: string): void {
    const { data } = this.ctx.state;
    const problems = this.left.get(path);
    if (problems === undefined) {
      if (data.attachments?.[path] === undefined) return;
      delete data.attachments[path];
    } else {
      const kept = (data.attachments ??= {});
      delete kept[path];
      kept[path] = {
        problems: problems.slice(0, ATTACHMENTS_PER_NOTE).map((one) => ({ name: one.name, why: one.why, ...(one.server ? { server: true as const } : {}) })),
        tries: this.tries.get(path) ?? 0,
      };
      const paths = Object.keys(kept);
      for (const old of paths.slice(0, Math.max(0, paths.length - ATTACHMENTS_KEPT))) delete kept[old];
    }
    this.ctx.saveSoon();
  }

  private enqueue(path: string, generation: number): void {
    this.timers.delete(path);
    if (!this.ctx.on() || !this.ctx.current(generation) || this.ctx.ports.retryAttachments === undefined) return;
    if (!this.queue.includes(path)) this.queue.push(path);
    void this.drain(generation);
  }

  private scheduleWake(ms: number, generation: number): void {
    this.wake?.();
    this.wake = this.ctx.ports.later(() => {
      this.wake = null;
      void this.drain(generation);
    }, ms);
  }

  private async drain(generation: number): Promise<void> {
    if (this.running || this.ctx.ports.retryAttachments === undefined) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && this.ctx.on() && this.ctx.current(generation)) {
        const path = this.queue[0]!;
        const row = this.ctx.looked()?.rows.find((one) => one.change.path === path);
        if (row === undefined) {
          this.queue.shift();
          this.problems(path, []);
          continue;
        }
        if (this.ctx.ports.hidden() || this.ctx.ports.personBusy() || this.ctx.ports.offline()) {
          this.scheduleWake(ATTACHMENT_BACKOFF_MS[0]!, generation);
          return;
        }
        const wait = this.ctx.budget.waitFor(WRITES_PER_FILE);
        if (wait > 0) {
          this.scheduleWake(wait, generation);
          return;
        }
        this.queue.shift();
        this.tries.set(path, (this.tries.get(path) ?? 0) + 1);
        this.keep(path);
        this.retrying.add(path);
        this.reported.delete(path);
        const hooks = {
          edit: true as const,
          notWritten: (one: string) => this.ctx.activity.notWritten(one),
          during: <T,>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null) => this.ctx.activity.during(paths, run, left),
        };
        const sent = await this.ctx.ports.retryAttachments(row, () => this.ctx.current(generation), hooks).catch(() => ({ result: "later" as const, writes: 0 }));
        if (!this.ctx.current(generation)) return;
        if (sent.writes > 0) this.ctx.budget.spend(sent.writes);
        if (sent.result === "done" && sent.writes > 0) this.ctx.budget.succeeded();
        this.retried(path, generation, sent.result);
        if (sent.result === "limited") {
          this.ctx.budget.limited(sent.retryAfterMs);
          this.scheduleWake(Math.max(0, this.ctx.budget.backoff().until - this.ctx.ports.now()), generation);
          return;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private retried(path: string, generation: number, result: "done" | "later" | "limited"): void {
    this.retrying.delete(path);
    if (!this.ctx.current(generation)) return;
    if (result === "done" && !this.reported.has(path)) this.problems(path, []);
    else if (result !== "done" && !this.reported.has(path)) {
      this.retrying.add(path);
      this.problems(path, this.left.get(path) ?? []);
      this.retrying.delete(path);
    }
  }
}
