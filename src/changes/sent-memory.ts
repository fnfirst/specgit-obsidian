import { eolOf, toLf, withEol } from "../disk/line-endings";
import { docKey, type DocumentRef } from "../mapping";
import { reviewIsOpen, type ReviewApi } from "../review/review-api";
import { gitBlobShaOfText } from "./blob-sha";
import { blobShasOf } from "./flow-helpers";
import type { FlowDeps } from "./flow-deps";
import type { ChangeRow, ChangesModel } from "./model";
import { type ReviewKey, reviewKey, sentToThis } from "./review-key";

export interface SentRecord {
  text: string;
  to: ReviewKey | null;
  doc: string;
  at: number;
  commit?: string;
}

export interface SentCacheEntry {
  sha: string;
  to: ReviewKey | null;
  commit?: string;
  at?: number;
}

export interface SentBaseDeps {
  readonly sentText: ReadonlyMap<string, SentRecord>;
  readonly heldCommits: Set<string>;
  cacheEntry(path: string, repo: string): SentCacheEntry | null;
  readonly review: Pick<ReviewApi, "status" | "mergePreview">;
  gitBlob(doc: DocumentRef, sha: string): Promise<string | null>;
  readonly publishedBranch: string;
  forget(path: string): void;
}

export interface SentMemoryHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
}

async function branchHoldsCommit(
  review: Pick<ReviewApi, "mergePreview">,
  publishedBranch: string,
  heldCommits: Set<string>,
  doc: DocumentRef,
  branch: string | undefined,
  commit: string | undefined,
): Promise<boolean | "unchecked" | null> {
  if (commit === undefined || branch === undefined) return "unchecked";
  const key = `${doc.repo}\n${branch}\n${commit}`;
  if (heldCommits.has(key)) return true;
  const seen = await review.mergePreview(doc, branch, publishedBranch, commit);
  if (!seen.ok) return null;
  const answer = (seen.body as { holds?: unknown } | null)?.holds;
  if (answer === undefined) return "unchecked";
  if (answer === true) heldCommits.add(key);
  return typeof answer === "boolean" ? answer : null;
}

export function sentBaseFor(deps: SentBaseDeps, path: string, doc: DocumentRef, since?: number): Promise<string | null> | null {
  const raw = deps.sentText.get(path);
  const kept = raw !== undefined && raw.doc === docKey(doc) ? raw : undefined;
  const entry = kept === undefined ? deps.cacheEntry(path, doc.repo) : null;
  if (kept === undefined && entry === null) return null;
  if (since !== undefined) {
    const at = kept !== undefined ? kept.at : entry!.at;
    if (at === undefined || at <= since) return null;
  }
  return (async (): Promise<string | null> => {
    const status = await deps.review.status(doc);
    if (status === null || !reviewIsOpen(status)) return null;
    const sentTo = kept !== undefined ? kept.to : entry!.to;
    const current = reviewKey(status.pr);
    if (sentTo === null || current === null) return null;
    const commit = kept !== undefined ? kept.commit : entry!.commit;
    const branch = status.reviewBranch ?? undefined;
    if (sentTo === current) {
      if (commit !== undefined) {
        const held = await branchHoldsCommit(deps.review, deps.publishedBranch, deps.heldCommits, doc, branch, commit);
        if (held === false) {
          deps.forget(path);
          return null;
        }
        if (held === null) return null;
      }
    } else {
      if (!sentTo.startsWith("pr:") || !current.startsWith("group:")) return null;
      const held = await branchHoldsCommit(deps.review, deps.publishedBranch, deps.heldCommits, doc, branch, commit);
      if (held !== true) return null;
    }
    if (kept !== undefined) return toLf(kept.text);
    const blob = await deps.gitBlob(doc, entry!.sha);
    return blob === null ? null : toLf(blob);
  })();
}

function verifiedSource(answer: Record<string, unknown> | null | undefined): { source: string | null; sha: string | null } {
  const sha = typeof answer?.contentSha === "string" && answer.contentSha !== "" ? answer.contentSha : null;
  const raw = typeof answer?.source === "string" ? answer.source : null;
  const source = raw !== null && (sha === null || gitBlobShaOfText(raw) === sha) ? raw : null;
  return { source, sha };
}

function heldBy(answer: Record<string, unknown> | null | undefined): { text: string } | { sha: string } | null {
  if (answer?.unchanged !== true) return null;
  const { source, sha } = verifiedSource(answer);
  if (source !== null) return { text: source };
  return sha !== null ? { sha } : null;
}

function returnedBy(answer: Record<string, unknown> | null | undefined): string | null {
  if (answer?.unchanged === true) return null;
  const { source, sha } = verifiedSource(answer);
  return source !== null && sha !== null ? source : null;
}

export class SentMemory {
  constructor(
    private readonly host: SentMemoryHost,
    private readonly write: (path: string, text: string, expected: string) => Promise<boolean> = (path, text, expected) => host.deps.writeText(path, text, expected),
    private readonly sentText: Map<string, SentRecord> = new Map(),
    private readonly acrossReviews = false,
  ) {}

  writingWith(write: (path: string, text: string, expected: string) => Promise<boolean>): SentMemory {
    return new SentMemory(this.host, write, this.sentText, true);
  }

  forget(path: string): void {
    this.sentText.delete(path);
  }

  remember = (path: string, text: string, to?: ReviewKey | null, held?: string, commit?: string, same?: boolean): Promise<void> =>
    this.rememberMany([[path, text]], to, held === undefined ? undefined : new Map([[path, { held, ...(commit === undefined ? {} : { commit }), ...(same === true ? { same: true as const } : {}) }]]));

  async rememberMany(sent: ReadonlyArray<readonly [string, string]>, to?: ReviewKey | null, held?: ReadonlyMap<string, { held: string; commit?: string; same?: true }>): Promise<void> {
    const review = (path: string): ReviewKey | null => to ?? this.host.model.reviewOf(path);
    const at = (this.host.deps.now ?? Date.now)();
    for (const [path, text] of sent) {
      const commit = held?.get(path)?.commit;
      const mapped = this.host.deps.documentFor(path);
      const doc = mapped ? docKey(mapped) : "";
      this.sentText.set(path, { text, to: review(path), doc, at, ...(commit === undefined ? {} : { commit }) });
    }
    const texts = new Map(sent);
    const agreements = new Map<string, { agreed?: string; commit?: string }>();
    for (const [path, one] of held ?? []) {
      const text = texts.get(path);
      const holdsIt = text !== undefined && (one.same === true || toLf(one.held) === toLf(text));
      agreements.set(path, { ...(holdsIt ? { agreed: gitBlobShaOfText(one.held) } : {}), ...(one.commit === undefined ? {} : { commit: one.commit }) });
    }
    this.host.model.learnSentMany((await blobShasOf(sent)).map(([path, sha]) => [path, sha, review(path), agreements.get(path)] as const));
  }

  async sentBase(row: ChangeRow, there: { text: string; sha: string }, branch?: string): Promise<string | undefined> {
    const last = await this.lastSent(row, there, branch);
    return typeof last === "string" ? undefined : last.text;
  }

  async lastSent(row: ChangeRow, there: { text: string; sha: string }, branch?: string): Promise<{ text: string } | "never" | "unreadable"> {
    const path = row.change.path;
    const raw = this.sentText.get(path);
    const kept = raw !== undefined && raw.doc === docKey(row.doc) ? raw : undefined;
    const sha = kept === undefined ? this.host.model.sentSha(path) : null;
    if (kept === undefined && sha === null) return "never";
    const holds = kept !== undefined ? kept.text === there.text : sha === there.sha;
    if (!holds && !this.acrossReviews) {
      if (!sentToThis(kept !== undefined ? kept.to : this.host.model.sentTo(path), await this.reviewNow(row))) return "never";
      const held = await this.branchHolds(row, branch, kept !== undefined ? kept.commit : this.host.deps.sentCommit?.(path));
      if (held === null) return "unreadable";
      if (!held) {
        this.forget(path);
        this.host.model.learnSent(path, null);
        return "never";
      }
    }
    if (kept !== undefined) return { text: kept.text };
    if (sha === there.sha) return { text: there.text };
    const blob = await this.host.deps.gitBlob(row.doc, sha!);
    return blob === null ? "unreadable" : { text: toLf(blob) };
  }

  private readonly heldCommits = new Set<string>();

  private async branchHolds(row: ChangeRow, branch: string | undefined, commit: string | undefined): Promise<boolean | null> {
    if (commit === undefined) return true;
    const name = branch ?? row.theirs?.branch ?? row.review?.reviewBranch ?? (await this.host.deps.review.status(row.doc))?.reviewBranch ?? undefined;
    const held = await branchHoldsCommit(this.host.deps.review, this.host.deps.publishedBranch, this.heldCommits, row.doc, name, commit);
    return held === "unchecked" ? true : held;
  }

  private async reviewNow(row: ChangeRow): Promise<ReviewKey | null> {
    const path = row.change.path;
    const group = this.host.model.groupOf(path)?.group;
    if (group) return `group:${group.overview.prNumber}`;
    const read = reviewKey(row.review?.pr) ?? (typeof row.theirs?.prNumber === "number" ? (`pr:${row.theirs.prNumber}` as const) : null);
    return read ?? this.host.model.reviewOf(path) ?? reviewKey((await this.host.deps.review.status(row.doc))?.pr);
  }

  async accepted(path: string, text: string, body: string, base: string | null = null, answer?: Record<string, unknown> | null): Promise<boolean> {
    const held = heldBy(answer);
    const returned = returnedBy(answer);
    const merged = returned !== null && toLf(returned) !== toLf(body) ? withEol(toLf(returned), eolOf(text)) : body;
    const remembered = held !== null ? ("text" in held ? held.text : null) : (returned ?? body);
    const commit = typeof answer?.commitSha === "string" && answer.commitSha !== "" ? answer.commitSha : undefined;
    const to = reviewKey(answer?.pr as { number?: unknown; group?: unknown } | null | undefined) ?? this.host.model.reviewOf(path);
    if (await this.writeAndRemember(path, text, merged, remembered, base, to, commit, held !== null)) {
      if (held !== null && "sha" in held) {
        this.forget(path);
        this.host.model.learnSent(path, held.sha, to);
      }
      return true;
    }
    await this.remember(path, text, to);
    return false;
  }

  async writeAndRemember(path: string, mine: string, merged: string, remembered: string | null, base: string | null = null, to?: ReviewKey | null, commit?: string, same = false): Promise<boolean> {
    if (toLf(merged) !== toLf(mine)) {
      if (!(await this.write(path, merged, mine))) return false;
      await this.host.deps.bringFor?.(path, merged).catch(() => undefined);
    }
    if (remembered !== null) await this.remember(path, remembered, to, toLf(merged) !== toLf(mine) ? merged : mine, commit, same);
    if (base !== null) this.host.model.rebased(path, base);
    return true;
  }
}
