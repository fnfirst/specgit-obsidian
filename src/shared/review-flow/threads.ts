import type { PrState } from "./pr-info";

export interface ThreadComment {
  id: string;
  body: string;
  author: { login: string; name?: string | null; avatarUrl: string | null } | null;
  createdAt: string;
  isBot: boolean;
  prNumber?: number;
  url?: string | null;
  pending?: boolean;
}

export interface ThreadSegmentView {
  prNumber: number;
  prUrl: string | null;
  threadId: string;
  threadUrl: string | null;
  date: string | null;
  state: "open" | "resolved" | "carried" | "reopened" | "pending";
}

export interface ThreadOriginView {
  path: string;
  commitSha: string;
  prNumber: number;
  url: string | null;
  author: string | null;
  createdAt: string | null;
}

export type ThreadStatus = "open" | "resolved_current" | "resolved_earlier";

export interface AnchoredThreadView {
  id: string;
  resolved: boolean;
  subjectType: "line" | "file" | "issue";
  reanchorStatus: "exact" | "fuzzy" | "outdated" | "unknown";
  anchor: { lineStart: number; lineEnd: number; quotedText: string; exactText?: string; path?: string; commitSha?: string } | null;
  displayComments: ThreadComment[];
  pending?: boolean;
  prNumber?: number;
  status?: ThreadStatus;
  segments?: ThreadSegmentView[];
  origin?: ThreadOriginView | null;
  reopenedEarlier?: boolean;
}

export interface RevisionView {
  prNumber: number;
  url: string;
  state: PrState;
  createdAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export type ThreadFilter = "open" | "resolved" | "all";

export function isResolvedEarlier(t: AnchoredThreadView): boolean {
  return t.status === "resolved_earlier";
}

export function conversationIds(t: AnchoredThreadView): string[] {
  return [t.id, ...(t.segments ?? []).map((s) => s.threadId)];
}

export function findConversation(threads: readonly AnchoredThreadView[], threadId: string): AnchoredThreadView | undefined {
  return threads.find((t) => t.id === threadId) ?? threads.find((t) => conversationIds(t).includes(threadId));
}

export function withPendingReplies(
  threads: readonly AnchoredThreadView[],
  pending: Iterable<{ threadId: string; comment: ThreadComment }>,
): AnchoredThreadView[] {
  let out = [...threads];
  for (const { threadId, comment } of pending) {
    const target = findConversation(out, threadId);
    if (!target || target.displayComments.some((c) => c.id === comment.id)) continue;
    out = out.map((t) => (t === target ? { ...t, displayComments: [...t.displayComments, comment] } : t));
  }
  return out;
}

const madeAt = (comment: ThreadComment): number => {
  const at = Date.parse(comment.createdAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
};

export function keepingComments(next: AnchoredThreadView, held: AnchoredThreadView | undefined, keep: (comment: ThreadComment) => boolean): AnchoredThreadView {
  if (!held) return next;
  const has = new Set(next.displayComments.map((c) => c.id));
  const place = new Map(held.displayComments.map((c, index) => [c.id, index]));
  const displayComments = [...next.displayComments];
  held.displayComments.forEach((comment, index) => {
    if (comment.pending || has.has(comment.id) || !keep(comment)) return;
    const made = madeAt(comment);
    const at = displayComments.findIndex((other) => madeAt(other) > made || (madeAt(other) === made && (place.get(other.id) ?? Number.POSITIVE_INFINITY) > index));
    displayComments.splice(at < 0 ? displayComments.length : at, 0, comment);
  });
  return displayComments.length === next.displayComments.length ? next : { ...next, displayComments };
}

export interface WriteAnswer<T extends AnchoredThreadView = AnchoredThreadView, C extends ThreadComment = ThreadComment> {
  thread?: T;
  comment?: C;
}

export function answeredOnto(answer: AnchoredThreadView, held: AnchoredThreadView, gone: (comment: ThreadComment) => boolean): AnchoredThreadView {
  const own = answer.displayComments.filter(
    (comment) => !gone(comment) && (answer.prNumber === undefined || comment.prNumber === undefined || comment.prNumber === answer.prNumber),
  );
  const joined = keepingComments({ ...held, displayComments: own }, held, () => true);
  const carried = answer.prNumber !== undefined && held.prNumber !== undefined && answer.prNumber !== held.prNumber;
  return carried ? { ...joined, id: answer.id, prNumber: answer.prNumber, segments: answer.segments, origin: answer.origin, reopenedEarlier: answer.reopenedEarlier } : joined;
}

export function repliedOnto(held: AnchoredThreadView, reply: ThreadComment): AnchoredThreadView {
  return keepingComments({ ...held, displayComments: [reply] }, held, () => true);
}

export function unaccountedFor(mine: readonly ThreadComment[], known: ReadonlyMap<string, number>): ThreadComment[] {
  const left = new Map(known);
  return mine.filter((comment) => {
    const at = momentOf(comment);
    const count = left.get(at) ?? 0;
    if (count > 0) left.set(at, count - 1);
    return count === 0;
  });
}

export function momentOf(comment: ThreadComment): string {
  const moment = Date.parse(comment.createdAt);
  return Number.isNaN(moment) ? comment.createdAt : String(moment);
}

export function commentIds(threads: readonly AnchoredThreadView[]): Set<string> {
  return new Set(threads.flatMap((thread) => thread.displayComments.map((comment) => comment.id)));
}

export function sameConversation(threads: readonly AnchoredThreadView[], thread: AnchoredThreadView): AnchoredThreadView | undefined {
  return pairListed([thread], threads).get(thread);
}

export function pairListed(listed: readonly AnchoredThreadView[], held: readonly AnchoredThreadView[]): Map<AnchoredThreadView, AnchoredThreadView> {
  const pairs = new Map<AnchoredThreadView, AnchoredThreadView>();
  const claimed = new Set<AnchoredThreadView>();
  const pass = (find: (thread: AnchoredThreadView, free: readonly AnchoredThreadView[]) => AnchoredThreadView | undefined): void => {
    for (const thread of listed) {
      if (pairs.has(thread)) continue;
      const mate = find(thread, held.filter((one) => !claimed.has(one)));
      if (!mate) continue;
      pairs.set(thread, mate);
      claimed.add(mate);
    }
  };
  pass((thread, free) => free.find((one) => one.id === thread.id));
  pass((thread, free) => free.find((one) => conversationIds(one).includes(thread.id)));
  pass((thread, free) => {
    const ids = commentIds([thread]);
    return free.find((one) => one.displayComments.some((comment) => ids.has(comment.id)));
  });
  pass((thread, free) => {
    const names = new Set(conversationIds(thread));
    return free.find((one) => conversationIds(one).some((id) => names.has(id)));
  });
  return pairs;
}

export function listedOnto(
  listed: readonly AnchoredThreadView[],
  held: readonly AnchoredThreadView[],
  awaited: (comment: ThreadComment) => boolean,
  pairing: ReadonlyMap<AnchoredThreadView, AnchoredThreadView>,
): AnchoredThreadView[] {
  const claimed = new Set(pairing.values());
  const kept = held.filter((thread) => {
    const first = thread.displayComments[0];
    return !claimed.has(thread) && (thread.pending === true || (first !== undefined && awaited(first)));
  });
  return [...listed.map((thread) => keepingComments(thread, pairing.get(thread), awaited)), ...kept];
}

export function replaceConversation(
  threads: readonly AnchoredThreadView[],
  oldId: string,
  next: AnchoredThreadView,
): AnchoredThreadView[] {
  const target = findConversation(threads, oldId);
  const out = threads.filter((t) => t !== target && t.id !== next.id);
  return [...out, next].sort(byPosition);
}

export function byPosition(a: AnchoredThreadView, b: AnchoredThreadView) {
  return (a.anchor?.lineStart ?? 1e9) - (b.anchor?.lineStart ?? 1e9);
}

export const RESOLVED_CAP_MS = 60_000;

export interface LocalIntent {
  resolved: boolean;
  at: number;
}

export function applyLocalIntents(threads: AnchoredThreadView[], intents: Map<string, LocalIntent>, now: number): AnchoredThreadView[] {
  if (intents.size === 0) return threads;
  for (const [id, click] of intents) if (click.at <= now - RESOLVED_CAP_MS) intents.delete(id);
  const clickOf = new Map<AnchoredThreadView, LocalIntent>();
  for (const [id, click] of intents) {
    const own = threads.find((thread) => thread.id === id);
    const earlier = own ? [own] : threads.filter((thread) => conversationIds(thread).includes(id));
    if (earlier.length === 1) clickOf.set(earlier[0]!, click);
  }
  return threads.map((thread) => {
    const click = clickOf.get(thread);
    if (!click || thread.resolved === click.resolved) return thread;
    return click.resolved ? { ...thread, resolved: true } : { ...thread, resolved: false, status: "open" };
  });
}

export function anchorWords(anchor: { quotedText: string; exactText?: string } | null | undefined): string {
  return anchor?.exactText?.trim() || anchor?.quotedText || "";
}
