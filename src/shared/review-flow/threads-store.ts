import { COMMENT_WORDS } from "./comment-copy";
import { currentThreads, visibleThreads } from "./comment-rules";
import type { PollGate } from "./poll-gate";
import { THREADS_POLL_MS } from "./poll-gate";
import { type EventReload, type LiveEvent, type SettleDeps } from "./live-events";
import { timeout } from "./timer";
import { CONFIRMED_CAP_MS, Ledger } from "./threads-ledger";
import {
  type AnchoredThreadView,
  answeredOnto,
  applyLocalIntents,
  byPosition,
  commentIds,
  conversationIds,
  findConversation,
  listedOnto,
  pairListed,
  repliedOnto,
  replaceConversation,
  RESOLVED_CAP_MS,
  momentOf,
  unaccountedFor,
  type LocalIntent,
  type RevisionView,
  sameConversation,
  type ThreadComment,
  type ThreadFilter,
  type ThreadStatus,
  type WriteAnswer,
  withPendingReplies,
} from "./threads";

export interface ThreadListing {
  threads?: AnchoredThreadView[];
  revisions?: RevisionView[];

  prNumber?: number | null;

  historyLoaded?: boolean;
}

export interface ThreadAnchorLines {
  lineStart: number;
  lineEnd: number;
}

export interface NewThread {
  lineStart: number;
  lineEnd: number;
  body: string;
  quotedText: string;
}

export interface ThreadsIo {
  list(history: boolean): Promise<ThreadListing>;
  create(input: NewThread): Promise<AnchoredThreadView>;

  write(threadId: string, action: string, extra: Record<string, unknown>, prNumber: number | undefined): Promise<WriteAnswer>;
}

export type LocalIntents = Map<string, LocalIntent>;

export function createLocalIntents(): LocalIntents {
  return new Map();
}

export interface ThreadsState {

  threads: readonly AnchoredThreadView[];

  visible: readonly AnchoredThreadView[];

  current: readonly AnchoredThreadView[];
  loading: boolean;
  error: string | null;
  filter: ThreadFilter;
  revisions: readonly RevisionView[];
  livePr: number | null;
  historyLoaded: boolean;
}

export type ThreadsMe = NonNullable<ThreadComment["author"]>;

export interface ThreadsStoreDeps {
  io: ThreadsIo;

  me(): ThreadsMe;
  intents?: LocalIntents;
  now?: () => number;

  settle?: SettleDeps;

  later?: (run: () => void, ms: number) => () => void;
}

interface SentReply {
  comment: ThreadComment;
  answeredAt?: number;
}

interface SameWords {

  threadId: string;

  words: string;

  known: Map<string, number>;

  out: Map<string, SentReply>;

  idleAt?: number;
}

const accountFor = (group: SameWords, comment: ThreadComment): void => void group.known.set(momentOf(comment), (group.known.get(momentOf(comment)) ?? 0) + 1);

interface Flight {
  id: string;
  intent: boolean;
  running: boolean;
  dirty: boolean;
}

interface Core {
  threads: readonly AnchoredThreadView[];
  loading: boolean;
  error: string | null;
  filter: ThreadFilter;
  revisions: readonly RevisionView[];
  livePr: number | null;
  historyLoaded: boolean;
}

const toState = (core: Core): ThreadsState => ({ ...core, visible: visibleThreads(core.threads, core.filter), current: currentThreads(core.threads) });

export class ThreadsStore {
  private core: Core = { threads: [], loading: true, error: null, filter: "open", revisions: [], livePr: null, historyLoaded: false };
  private state: ThreadsState = toState(this.core);
  private readonly listeners = new Set<() => void>();
  private readonly intents: LocalIntents;
  private readonly now: () => number;

  private readonly ledger = new Ledger();

  private readonly aliases = new Map<string, { to: string; at: number }>();

  private timer: (() => void) | null = null;

  private firedAt: number | null = null;

  private retry: (() => void) | null = null;

  private awaiting = false;
  private watched: number | null = null;
  private readonly later: (run: () => void, ms: number) => () => void;

  private readonly sent: SameWords[] = [];

  private reads = 0;
  private applied = 0;
  private replySeq = 0;

  private readonly flights = new Map<string, Flight>();

  private reaction: EventReload | null = null;

  constructor(private readonly deps: ThreadsStoreDeps) {
    this.intents = deps.intents ?? createLocalIntents();
    this.now = deps.now ?? Date.now;
    this.later = deps.later ?? deps.settle?.later ?? timeout;
  }

  heard = (event: LiveEvent): void => {
    if (this.concerns(event)) this.reaction?.heard(event);
  };

  private concerns(event: LiveEvent): boolean {
    if (event.pr === undefined || this.core.livePr === null) return true;
    return event.pr === this.core.livePr || this.core.threads.some((thread) => thread.prNumber === event.pr) || this.core.revisions.some((revision) => revision.prNumber === event.pr);
  }

  catchUp = (first = false): void => this.reaction?.catchUp(first);

  getState = (): ThreadsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(change: Partial<Core>): void {
    this.core = { ...this.core, ...change };
    this.state = toState(this.core);
    this.listeners.forEach((listener) => listener());
  }

  private began(): number {
    return this.reads;
  }

  private absorb({ written, answer, since, placeholder }: { written: string; answer: WriteAnswer; since: number; placeholder?: string }): void {
    const threads = placeholder === undefined ? this.core.threads : this.core.threads.filter((thread) => thread.id !== placeholder);
    const held = findConversation(threads, this.current(written)) ?? (answer.thread ? sameConversation(threads, answer.thread) : undefined);
    const gone = (comment: ThreadComment): boolean => this.ledger.gone(comment.id, since);
    let next: AnchoredThreadView | undefined;
    if (answer.thread) next = held ? answeredOnto(answer.thread, held, gone) : answer.thread;

    if (answer.comment) {
      const target = next ?? held;
      if (target) next = repliedOnto(target, answer.comment);
    }
    if (!next) return;
    if (held && next.id !== held.id) this.renamed(conversationIds(held), next.id);
    if (held || placeholder !== undefined) {
      const shown = commentIds(held ? [held] : []);
      const login = this.deps.me().login;
      const brought = next.displayComments.filter((comment) => !shown.has(comment.id) || comment.id === answer.comment?.id);
      const first = next.displayComments[0];

      const mine = (comment: ThreadComment): boolean => (placeholder !== undefined ? comment === first : answer.comment ? comment.id === answer.comment.id : comment.author?.login === login);
      this.ledger.brought(brought.filter(mine).map((comment) => comment.id), this.now());
      this.ledger.heardFrom(brought.filter((comment) => !mine(comment)).map((comment) => comment.id), this.reads);
    }
    const joined = this.withoutDuplicates(replaceConversation(threads, held?.id ?? written, next));
    this.set({ threads: withPendingReplies(joined.threads, joined.replies) });
  }

  private current(id: string): string {
    const seen = new Set<string>();
    let at = id;
    while (!seen.has(at)) {
      seen.add(at);
      const next = this.aliases.get(at);
      if (next === undefined) return at;
      at = next.to;
    }
    return at;
  }

  private renamed(from: readonly string[], to: string): void {
    const names = from.filter((id) => id !== to);
    const now = this.now();
    this.aliases.delete(to);
    for (const [id, alias] of this.aliases) if (names.includes(alias.to)) this.aliases.set(id, { to, at: now });
    for (const id of names) this.aliases.set(id, { to, at: now });
    for (const group of this.sent) if (names.includes(group.threadId)) group.threadId = to;
    for (const id of names) {

      const click = this.intents.get(id);
      if (click) {
        this.intents.delete(id);
        if ((this.intents.get(to)?.at ?? Number.NEGATIVE_INFINITY) <= click.at) this.intents.set(to, click);
      }
      const flight = this.flights.get(id);
      if (flight && !this.flights.has(to)) {
        this.flights.delete(id);
        flight.id = to;
        this.flights.set(to, flight);
      }
    }
  }

  private assignStandIns(real: readonly AnchoredThreadView[], readStartedAt?: number): { threadId: string; comment: ThreadComment }[] {
    const now = this.now();
    const drawn: { threadId: string; comment: ThreadComment }[] = [];
    for (const group of [...this.sent]) {
      if (group.out.size === 0 && now - (group.idleAt ?? now) > CONFIRMED_CAP_MS) {
        this.sent.splice(this.sent.indexOf(group), 1);
        continue;
      }
      const conversation = findConversation(real, group.threadId);
      const free = conversation === undefined ? [] : unaccountedFor(conversation.displayComments.filter((comment) => this.sameWords(comment, group.words)), group.known);
      const out = [...group.out];
      const takers = [...out.filter(([, reply]) => reply.answeredAt !== undefined), ...out.filter(([, reply]) => reply.answeredAt === undefined)];
      takers.forEach(([id, reply], index) => {
        const standIn = free[index];
        if (reply.answeredAt !== undefined && standIn !== undefined) {
          accountFor(group, standIn);
          group.out.delete(id);
        } else if (reply.answeredAt !== undefined && readStartedAt !== undefined && readStartedAt - reply.answeredAt > CONFIRMED_CAP_MS) group.out.delete(id);
        else if (standIn === undefined) drawn.push({ threadId: group.threadId, comment: reply.comment });
      });
      if (group.out.size === 0) group.idleAt ??= now;
    }
    return drawn;
  }

  private madeBy(answer: AnchoredThreadView | undefined, group: SameWords): ThreadComment | undefined {
    const mine = (thread: AnchoredThreadView | undefined): ThreadComment[] => (thread?.displayComments ?? []).filter((comment) => this.sameWords(comment, group.words));
    const seen = new Map(group.known);
    const shown = new Map<string, number>();
    for (const comment of mine(findConversation(this.core.threads, group.threadId))) shown.set(momentOf(comment), (shown.get(momentOf(comment)) ?? 0) + 1);
    for (const [time, count] of shown) seen.set(time, Math.max(seen.get(time) ?? 0, count));
    const unseen = unaccountedFor(mine(answer), seen);
    return unseen[unseen.length - 1];
  }

  private groupFor(threadId: string, body: string): SameWords {
    const words = body.trim();
    let group = this.sent.find((candidate) => candidate.threadId === threadId && candidate.words === words);
    if (group === undefined) {
      group = { threadId, words, known: new Map(), out: new Map() };
      this.sent.push(group);
    }
    if (group.out.size === 0) {
      for (const comment of unaccountedFor((findConversation(this.core.threads, threadId)?.displayComments ?? []).filter((comment) => this.sameWords(comment, body)), group.known)) accountFor(group, comment);
    }
    delete group.idleAt;
    return group;
  }

  private setThreads(change: (threads: readonly AnchoredThreadView[]) => readonly AnchoredThreadView[]): void {
    this.set({ threads: change(this.core.threads) });
  }

  private sameWords(comment: ThreadComment, body: string): boolean {
    return !comment.pending && comment.author?.login === this.deps.me().login && comment.body.trim() === body.trim();
  }

  private withoutDuplicates(threads: AnchoredThreadView[], readStartedAt?: number): { threads: AnchoredThreadView[]; replies: { threadId: string; comment: ThreadComment }[] } {
    const real = threads.filter((thread) => !thread.pending);
    const replies = this.assignStandIns(real, readStartedAt);
    const wasShown = (other: AnchoredThreadView): boolean => sameConversation(this.core.threads, other) !== undefined;
    const used = new Set<string>();
    const kept = threads.filter((thread) => {
      const first = thread.displayComments[0];
      if (!thread.pending || !first) return true;
      const same = real.filter((other) => other.anchor?.lineStart === thread.anchor?.lineStart && !wasShown(other));
      return !same.some((other) => {
        const found = other.displayComments.find((c) => !used.has(c.id) && this.sameWords(c, first.body));
        if (found) used.add(found.id);
        return found !== undefined;
      });
    });
    return { threads: kept, replies };
  }

  reload = async (): Promise<void> => {
    const order = ++this.reads;
    if (this.awaiting) {

      this.awaiting = false;
      this.watched = order;
    }
    const startedAt = this.now();
    const history = this.core.filter !== "open";
    try {
      const listing = await this.deps.io.list(history);
      if (order < this.applied) {
        if (this.watched === order) this.watched = null;
        return;
      }
      this.applied = order;
      const now = this.now();

      const raw = listing.threads ?? [];
      const pairs = pairListed(raw, this.core.threads);
      for (const [thread, held] of pairs) {
        if (held.id === thread.id) continue;
        this.renamed(conversationIds(held), thread.id);
      }
      const listed = applyLocalIntents(raw, this.intents, now);
      const pairing = new Map(listed.flatMap((thread, index) => (pairs.has(raw[index]!) ? [[thread, pairs.get(raw[index]!)!] as const] : [])));
      const merged = listedOnto(listed, this.core.threads, (comment) => this.ledger.awaited(comment.id, { startedAt, order }), pairing);

      const unduplicated = this.withoutDuplicates(merged, startedAt);
      const threads = withPendingReplies(unduplicated.threads, unduplicated.replies).sort(byPosition);

      const before = this.core.threads.flatMap((thread) => (thread.pending ? [] : thread.displayComments.filter((comment) => !comment.pending).map((comment) => comment.id)));
      this.ledger.settled({ order, now }, commentIds(listed), before, commentIds(threads));
      for (const [id, alias] of this.aliases) if (alias.at <= now - CONFIRMED_CAP_MS) this.aliases.delete(id);
      this.set({
        revisions: Array.isArray(listing.revisions) ? listing.revisions : [],
        livePr: typeof listing.prNumber === "number" ? listing.prNumber : null,
        historyLoaded: listing.historyLoaded === true,
        threads,
        error: null,
        loading: false,
      });
      if (this.watched === order) this.watched = null;

      if (!history && order === this.reads && this.core.filter !== "open" && !this.core.historyLoaded) void this.reload();
    } catch (error) {

      if (order >= this.applied) this.set({ error: (error as Error).message, loading: false });

      if (this.watched === order && this.reaction !== null) {
        this.watched = null;
        this.askAgain();
      }
    }
  };

  setFilter = (filter: ThreadFilter): void => {
    if (filter === this.core.filter) return;
    this.set({ filter });
    if (filter !== "open" && !this.core.historyLoaded) void this.reload();
  };

  startPolling(gate: PollGate, every: (run: () => void, ms: number) => () => void): () => void {
    const poll = (): void => {
      gate.ran();
      void this.reload();
    };
    poll();
    const stopTimer = every(() => {
      if (gate.due()) poll();
    }, THREADS_POLL_MS);

    const reaction = gate.reaction(poll, this.deps.settle);
    this.reaction = reaction;
    const stopReaction = reaction.start();
    const stopShown = gate.onShown(poll, this.deps.settle);
    const stopFocused = gate.onFocused(poll, this.deps.settle);
    this.arm();
    return () => {
      stopTimer();
      stopShown();
      stopFocused();
      stopReaction();
      this.reaction = null;
      this.stopWaiting();
    };
  }

  private author(): ThreadComment["author"] {
    return this.deps.me();
  }

  createThread = async (input: NewThread, ensureSaved?: () => Promise<void | ThreadAnchorLines>): Promise<AnchoredThreadView> => {
    const tempId = `temp:${this.now()}`;
    const optimistic: AnchoredThreadView = {
      id: tempId,
      resolved: false,
      subjectType: "line",
      reanchorStatus: "exact",
      anchor: { lineStart: input.lineStart, lineEnd: input.lineEnd, quotedText: input.quotedText, exactText: input.quotedText },
      displayComments: [
        {
          id: `${tempId}:c`,
          body: input.body,
          author: this.author(),
          createdAt: new Date(this.now()).toISOString(),
          isBot: false,
        },
      ],
      pending: true,
    };
    this.setThreads((threads) => [...threads, optimistic].sort(byPosition));

    try {
      let { lineStart, lineEnd } = input;
      if (ensureSaved) {
        const revised = await ensureSaved();
        if (revised) {
          lineStart = revised.lineStart;
          lineEnd = revised.lineEnd;
          this.setThreads((threads) =>
            threads.map((thread) => (thread.id === tempId && thread.anchor ? { ...thread, anchor: { ...thread.anchor, lineStart, lineEnd } } : thread)),
          );
        }
      }
      const since = this.began();
      const real = await this.deps.io.create({ ...input, lineStart, lineEnd });

      this.absorb({ written: real.id, answer: { thread: real }, since, placeholder: tempId });
      return sameConversation(this.core.threads, real) ?? real;
    } catch (error) {
      this.setThreads((threads) => threads.filter((thread) => thread.id !== tempId));
      throw error;
    }
  };

  reply = async (threadId: string, body: string): Promise<void> => {
    const comment: ThreadComment = {
      id: `temp:${this.now()}:reply:${++this.replySeq}`,
      body,
      author: this.author(),
      createdAt: new Date(this.now()).toISOString(),
      isBot: false,
      pending: true,
    };

    const group = this.groupFor(this.current(threadId), body);
    const sent: SentReply = { comment };
    group.out.set(comment.id, sent);
    this.setThreads((threads) => withPendingReplies(threads, [{ threadId: group.threadId, comment }]));
    const since = this.began();
    const left = (): void => {
      group.out.delete(comment.id);
      if (group.out.size === 0) group.idleAt = this.now();
    };
    try {
      const data = await this.write(threadId, "comments", { body });
      if (data.comment) {
        accountFor(group, data.comment);
        left();
      } else {

        const own = this.madeBy(data.thread, group);
        if (own === undefined) sent.answeredAt = this.now();
        else {
          accountFor(group, own);
          left();
        }
      }
      this.absorb({ written: group.threadId, answer: data, since });
    } catch (error) {
      left();
      this.setThreads((threads) => threads.map((thread) => ({ ...thread, displayComments: thread.displayComments.filter((c) => c.id !== comment.id) })));
      throw error;
    }
  };

  write = (threadId: string, action: string, extra: Record<string, unknown>): Promise<WriteAnswer> => {
    const id = this.current(threadId);
    const prNumber = findConversation(this.core.threads, id)?.prNumber;
    return this.deps.io.write(id, action, extra, prNumber);
  };

  private rememberIntent(threadId: string, resolved: boolean): void {
    const now = this.now();
    const id = this.current(threadId);
    this.intents.set(id, { resolved, at: now });
    this.arm();
  }

  private arm(): void {
    this.disarm();
    if (this.reaction === null) return;
    const now = this.now();
    const standing = [...this.intents.values()].filter((click) => click.at + RESOLVED_CAP_MS > now);
    if (standing.length === 0) {
      this.firedAt = null;
      return;
    }
    const firedAt = this.firedAt;
    const end = (click: LocalIntent): number => click.at + RESOLVED_CAP_MS;

    const batch = standing.filter((click) => firedAt !== null && click.at <= firedAt).map(end);
    const fresh = standing.filter((click) => firedAt === null || click.at > firedAt).map(end);
    this.timer = this.later(() => {
      this.timer = null;
      this.firedAt = this.now();
      this.awaiting = true;
      this.catchUp();
      this.arm();
    }, Math.min(...fresh, batch.length > 0 ? Math.max(...batch) : Number.POSITIVE_INFINITY) - now);
  }

  private askAgain(): void {
    this.retry = this.later(() => {
      this.retry = null;
      this.catchUp();
    }, 5_000);
  }

  private disarm(): void {
    this.timer?.();
    this.timer = null;
  }

  private stopWaiting(): void {
    this.disarm();
    this.retry?.();
    this.retry = null;
    this.awaiting = false;
    this.watched = null;
  }

  private forgetIntent(threadId: string): void {
    this.intents.delete(this.current(threadId));
    this.arm();
  }

  private flightOf(threadId: string): Flight | undefined {
    return this.flights.get(this.current(threadId));
  }

  resolve = (threadId: string, resolved: boolean): Promise<void> => {
    const id = this.current(threadId);
    const flight = this.flightOf(id) ?? { id, intent: resolved, running: false, dirty: false };
    flight.intent = resolved;
    flight.dirty = true;
    this.flights.set(flight.id, flight);
    const status: ThreadStatus = resolved ? "resolved_current" : "open";
    this.setThreads((threads) => {
      const target = findConversation(threads, id);
      return threads.map((thread) => (thread === target ? { ...thread, resolved, status } : thread));
    });
    this.rememberIntent(id, resolved);
    if (flight.running) return Promise.resolve();

    flight.running = true;
    return (async () => {
      try {
        while (flight.dirty) {
          flight.dirty = false;
          const intent = flight.intent;
          const since = this.began();
          let confirmed: AnchoredThreadView | undefined;
          try {
            confirmed = (await this.write(flight.id, "resolve", { resolved: intent })).thread;
          } catch {
            if (flight.intent !== intent) continue;
            this.forgetIntent(flight.id);
            void this.reload();
            return;
          }
          if (flight.intent !== intent) continue;

          const landed: ThreadStatus = intent ? "resolved_current" : "open";
          this.setThreads((threads) => {
            const target = findConversation(threads, this.current(flight.id));
            return threads.map((thread) => (thread === target ? { ...thread, resolved: intent, status: landed } : thread));
          });
          this.rememberIntent(flight.id, intent);
          if (confirmed) this.absorb({ written: flight.id, answer: { thread: confirmed }, since });
        }
      } finally {
        flight.running = false;
        if (flight.dirty) void this.resolve(flight.id, flight.intent);
        else if (this.flights.get(flight.id) === flight) this.flights.delete(flight.id);
      }
    })();
  };

  resolveAllLocally(): AnchoredThreadView[] {
    const open = this.core.threads.filter((thread) => !thread.resolved && !thread.pending);
    for (const thread of open) {
      this.rememberIntent(thread.id, true);

      const flight = this.flightOf(thread.id);
      if (flight) {
        flight.intent = true;
        flight.dirty = true;
      }
    }
    this.setThreads((threads) => threads.map((thread) => (open.includes(thread) ? { ...thread, resolved: true, status: "resolved_current" as const } : thread)));
    return open;
  }

  forgetResolved(threads: readonly AnchoredThreadView[]): void {
    for (const thread of threads) this.forgetIntent(thread.id);
  }
}

export function failureWords(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : COMMENT_WORDS.saveFailed;
}
