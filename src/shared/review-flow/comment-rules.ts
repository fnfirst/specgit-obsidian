import { COMMENT_WORDS } from "./comment-copy";
import { threadVersions } from "./comment-groups";
import { hasSuggestionBody } from "./suggestion-block";
import { type AnchoredThreadView, anchorWords, isResolvedEarlier, type RevisionView, type ThreadFilter } from "./threads";

export function commenterName(author: { login: string; name?: string | null } | null | undefined): string | null {
  return author?.name?.trim() || author?.login || null;
}

export function subjectChip(thread: { subjectType: "line" | "file" | "issue"; anchor: { quotedText: string; exactText?: string } | null }): string | null {
  if (thread.subjectType === "line") return null;
  return anchorWords(thread.anchor).trim() === "" ? COMMENT_WORDS.wholeNote : null;
}

const AGENT_BYLINE = /^🤖 \*\*([^\n*]+) for ([A-Za-z0-9-]+)\*\*/u;

const markdownSafe = (name: string): string => name.replace(/[\\`*_[\]<>#|~]/g, "\\$&");

export function agentPrefixShown(body: string, author: { login: string; name?: string | null } | null | undefined): string {
  const name = author?.name?.trim();
  const byline = AGENT_BYLINE.exec(body);
  if (!author || !name || !byline || byline[2]!.toLowerCase() !== author.login.toLowerCase()) return body;
  return `🤖 **${byline[1]} for ${markdownSafe(name)}**${body.slice(byline[0].length)}`;
}

const MENTION_USER = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\b/;

function scanFenceEnd(markdown: string, lineStart: number): number | null {
  const nl = markdown.indexOf("\n", lineStart);
  const line = nl === -1 ? markdown.slice(lineStart) : markdown.slice(lineStart, nl);
  const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!open) return null;
  const fence = open[1]!;
  const ch = fence[0]!;
  if (ch === "`" && open[2]!.indexOf("`") !== -1) return null;
  if (nl === -1) return markdown.length;
  let pos = nl + 1;
  while (pos < markdown.length) {
    const nextNl = markdown.indexOf("\n", pos);
    const cur = nextNl === -1 ? markdown.slice(pos) : markdown.slice(pos, nextNl);
    const trimmed = cur.replace(/^ {0,3}/, "");
    if (trimmed.length >= fence.length && trimmed.indexOf(ch.repeat(fence.length)) === 0) {
      let restAt = fence.length;
      while (restAt < trimmed.length && trimmed[restAt] === ch) restAt++;
      if (/^[ \t]*\r?$/.test(trimmed.slice(restAt))) return nextNl === -1 ? markdown.length : nextNl + 1;
    }
    if (nextNl === -1) return markdown.length;
    pos = nextNl + 1;
  }
  return markdown.length;
}

function scanCodeSpanEnd(markdown: string, start: number): number {
  let ticks = 0;
  while (start + ticks < markdown.length && markdown[start + ticks] === "`") ticks++;
  let pos = start + ticks;
  while (pos < markdown.length) {
    if (markdown[pos] === "`") {
      let closeTicks = 0;
      while (pos + closeTicks < markdown.length && markdown[pos + closeTicks] === "`") closeTicks++;
      if (closeTicks === ticks) return pos + closeTicks;
      pos += closeTicks;
    } else {
      pos++;
    }
  }
  return start + ticks;
}

function scanInlineLinkEnd(markdown: string, start: number): number | null {
  if (markdown[start] !== "[") return null;
  let depth = 0;
  let pos = start;
  while (pos < markdown.length) {
    const ch = markdown[pos];
    if (ch === "\\" && pos + 1 < markdown.length) {
      pos += 2;
      continue;
    }
    if (ch === "`") {
      pos = scanCodeSpanEnd(markdown, pos);
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "\n") {
      return null;
    }
    pos++;
  }
  if (depth !== 0 || markdown[pos + 1] !== "(") return null;
  let parenDepth = 0;
  let urlPos = pos + 1;
  while (urlPos < markdown.length) {
    const ch = markdown[urlPos];
    if (ch === "\\" && urlPos + 1 < markdown.length) {
      urlPos += 2;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) return urlPos + 1;
    } else if (ch === "\n") {
      return null;
    }
    urlPos++;
  }
  return null;
}

export function linkifyMentions(markdown: string): string {
  let out = "";
  let i = 0;
  while (i < markdown.length) {
    if (i === 0 || markdown[i - 1] === "\n") {
      const fenceEnd = scanFenceEnd(markdown, i);
      if (fenceEnd !== null) {
        out += markdown.slice(i, fenceEnd);
        i = fenceEnd;
        continue;
      }
    }
    const ch = markdown[i]!;
    if (ch === "`") {
      const end = scanCodeSpanEnd(markdown, i);
      out += markdown.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[") {
      const linkEnd = scanInlineLinkEnd(markdown, i);
      if (linkEnd !== null) {
        out += markdown.slice(i, linkEnd);
        i = linkEnd;
        continue;
      }
    }
    if (ch === "@") {
      const prev = i === 0 ? "" : markdown[i - 1]!;
      if (prev === "" || !/[\w@`]/.test(prev)) {
        const match = MENTION_USER.exec(markdown.slice(i + 1));
        if (match) {
          const user = match[1]!;
          out += `[@${user}](https://github.com/${user})`;
          i += 1 + user.length;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function picturesAsWords(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => (alt === "" ? "" : `[${alt}]`));
}

export function mediaAsWords(markdown: string): string {
  const words = (alt: string | undefined): string => (alt ? `[${alt}]` : "");
  return picturesAsWords(markdown)
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_match, alt: string) => words(alt))
    .replace(/<(img|video|audio|iframe|embed|object|source)\b[^>]*>/gi, (tag: string) => words(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)?.slice(1).find(Boolean)))
    .replace(/<\/(video|audio|iframe|object)\s*>/gi, "");
}

export function currentThreads(threads: readonly AnchoredThreadView[]): AnchoredThreadView[] {
  return threads.filter((thread) => !isResolvedEarlier(thread));
}

export function visibleThreads(threads: readonly AnchoredThreadView[], filter: ThreadFilter): AnchoredThreadView[] {
  return threads.filter((thread) => (filter === "all" ? true : filter === "resolved" ? thread.resolved : !thread.resolved));
}

export function openThreadCount(threads: readonly AnchoredThreadView[]): number {
  return currentThreads(threads).filter((thread) => !thread.resolved).length;
}

export function openListedCount(listed: readonly AnchoredThreadView[]): number {
  return listed.filter((thread) => !thread.resolved && !thread.pending).length;
}

export function offersResolveAll(options: { canWrite: boolean; available: boolean; openCount: number }): boolean {
  return options.canWrite && options.available && options.openCount >= 2;
}

export function canReply(thread: Pick<AnchoredThreadView, "resolved" | "pending">, canWrite: boolean): boolean {
  return canWrite && !thread.resolved && !thread.pending;
}

export function holdsSuggestion(thread: Pick<AnchoredThreadView, "displayComments">): boolean {
  return thread.displayComments.some((comment) => hasSuggestionBody(comment.body));
}

export function offersApply(thread: Pick<AnchoredThreadView, "displayComments">, canApply: boolean): boolean {
  return canApply && thread.displayComments[0] !== undefined && holdsSuggestion(thread);
}

export function offersVersion(thread: AnchoredThreadView, revisions: readonly RevisionView[] | undefined, surfaceShowsVersions: boolean): boolean {
  return surfaceShowsVersions && (isResolvedEarlier(thread) || thread.reanchorStatus === "outdated") && threadVersions(thread, revisions).length > 0;
}

export function emptyListWords(canWrite: boolean): string {
  return canWrite ? COMMENT_WORDS.emptyWriter : COMMENT_WORDS.emptyReader;
}

export function historyPending(filter: ThreadFilter, historyLoaded: boolean | undefined, revisions: readonly RevisionView[] | undefined): boolean {
  return filter !== "open" && historyLoaded === false && (revisions?.length ?? 0) > 1;
}

export function resolvedBadge(thread: Pick<AnchoredThreadView, "status" | "prNumber">): string {
  return thread.status === "resolved_earlier" && thread.prNumber ? COMMENT_WORDS.resolvedIn(thread.prNumber) : COMMENT_WORDS.resolved;
}

export const RESOLVE_FADE_MS = 450;
export const RESOLVE_COMMIT_MS = 800;

export function leavesTheList(filter: ThreadFilter, action: "resolve" | "reopen"): boolean {
  return (filter === "open" && action === "resolve") || (filter === "resolved" && action === "reopen");
}

export function canPost(body: string, busy: boolean, locked: boolean): boolean {
  return body.trim() !== "" && !busy && !locked;
}

export function canSendReply(body: string, sending: boolean): boolean {
  return body.trim() !== "" && !sending;
}

export function timeAgo(iso: string, now: number): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const COMMENT_SAVE_WAIT = { everyMs: 2_000, maxMs: 60_000 } as const;
