import { stripBom, toLf, withBomAndEol } from "../disk/line-endings";
import { docKey, type DocumentRef } from "../mapping";
import { reviewIsOpen, type ReviewApi } from "../review/review-api";
import type { PrInfo } from "../shared/review-flow";
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
  unwritten?: true;
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
  gitBlob(doc: DocumentRef, sha: string, signal?: AbortSignal): Promise<string | null>;
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
  signal?: AbortSignal,
): Promise<boolean | "unchecked" | null> {
  if (signal?.aborted) return null;
  if (commit === undefined || branch === undefined) return "unchecked";
  const key = `${doc.repo}\n${branch}\n${commit}`;
  if (heldCommits.has(key)) return true;
  const seen = await review.mergePreview(doc, branch, publishedBranch, commit, signal);
  if (signal?.aborted || !seen.ok) return null;
  const answer = (seen.body as { holds?: unknown } | null)?.holds;
  if (answer === undefined) return "unchecked";
  if (answer === true) heldCommits.add(key);
  return typeof answer === "boolean" ? answer : null;
}

export function sentBaseFor(deps: SentBaseDeps, path: string, doc: DocumentRef, since?: number, signal?: AbortSignal): Promise<string | null> | null {
  const raw = deps.sentText.get(path);
  const kept = raw !== undefined && raw.doc === docKey(doc) ? raw : undefined;
  const entry = kept === undefined ? deps.cacheEntry(path, doc.repo) : null;
  if (kept === undefined && entry === null) return null;
  if (since !== undefined) {
    const at = kept !== undefined ? kept.at : entry!.at;
    if (at === undefined || at <= since) return null;
  }
  if (signal?.aborted) return null;
  return (async (): Promise<string | null> => {
    if (signal?.aborted) return null;
    const status = await deps.review.status(doc, signal);
    if (signal?.aborted || status === null || !reviewIsOpen(status)) return null;
    const sentTo = kept !== undefined ? kept.to : entry!.to;
    const current = reviewKey(status.pr);
    if (sentTo === null || current === null) return null;
    const commit = kept !== undefined ? kept.commit : entry!.commit;
    const branch = status.reviewBranch ?? undefined;
    if (sentTo === current) {
      if (commit !== undefined) {
        const held = await branchHoldsCommit(deps.review, deps.publishedBranch, deps.heldCommits, doc, branch, commit, signal);
        if (signal?.aborted) return null;
        if (held === false) {
          deps.forget(path);
          return null;
        }
        if (held === null) return null;
      }
    } else {
      if (!sentTo.startsWith("pr:") || !current.startsWith("group:")) return null;
      const held = await branchHoldsCommit(deps.review, deps.publishedBranch, deps.heldCommits, doc, branch, commit, signal);
      if (signal?.aborted || held !== true) return null;
    }
    if (signal?.aborted) return null;
    if (kept !== undefined) return toLf(kept.text);
    const blob = await deps.gitBlob(doc, entry!.sha, signal);
    if (signal?.aborted) return null;
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
    private readonly write: (path: string, text: string, expected: string) => Promise<boolean | string> = (path, text, expected) => host.deps.writeText(path, text, expected),
    private readonly sentText: Map<string, SentRecord> = new Map(),
    private readonly acrossReviews = false,
  ) {}

  writingWith(write: (path: string, text: string, expected: string) => Promise<boolean | string>): SentMemory {
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
      const holdsIt = text !== undefined && (one.same === true || stripBom(toLf(one.held)) === stripBom(toLf(text)));
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
    if (!holds && (!this.acrossReviews || kept?.unwritten === true)) {
      if (!sentToThis(kept !== undefined ? kept.to : this.host.model.sentTo(path), await this.reviewNow(row))) return "never";
      const held = await this.branchHolds(row, branch, kept !== undefined ? kept.commit : this.host.deps.sentCommit?.(path));
      if (held === null) return "unreadable";
      if (!held) {
        this.forget(path);
        if (!kept?.unwritten) this.host.model.learnSent(path, null);
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

  private rememberLocally(path: string, text: string, to: ReviewKey | null, commit?: string): void {
    const mapped = this.host.deps.documentFor(path);
    const doc = mapped ? docKey(mapped) : "";
    const at = (this.host.deps.now ?? Date.now)();
    this.sentText.set(path, { text: toLf(text), to, doc, at, ...(commit === undefined ? {} : { commit }), unwritten: true });
  }

  async localSentBase(path: string, doc: DocumentRef, draft: { branch: string; prNumber: number | null; inGroup?: true }): Promise<string | null> {
    const raw = this.sentText.get(path);
    if (!raw?.unwritten || raw.doc !== docKey(doc)) return null;
    const current: ReviewKey | null = draft.prNumber === null ? null : `${draft.inGroup ? "group" : "pr"}:${draft.prNumber}`;
    if (raw.to === null || current === null) return null;
    if (raw.to === current) {
      if (raw.commit !== undefined) {
        const held = await branchHoldsCommit(this.host.deps.review, this.host.deps.publishedBranch, this.heldCommits, doc, draft.branch, raw.commit);
        if (held === false) {
          this.forget(path);
          return null;
        }
        if (held === null) return null;
      }
    } else {
      if (!raw.to.startsWith("pr:") || !current.startsWith("group:")) return null;
      const held = await branchHoldsCommit(this.host.deps.review, this.host.deps.publishedBranch, this.heldCommits, doc, draft.branch, raw.commit);
      if (held !== true) return null;
    }
    return toLf(raw.text);
  }

  private learnFromAnswer(path: string, answer?: Record<string, unknown> | null): void {
    if (!answer || this.host.model.state().busy) return;
    const raw = answer.pr as (Partial<PrInfo> & { headRef?: unknown }) | null | undefined;
    const branch =
      typeof answer.reviewBranch === "string" && answer.reviewBranch !== ""
        ? answer.reviewBranch
        : typeof raw?.headRef === "string" && raw.headRef !== ""
          ? raw.headRef
          : null;
    const existing = this.host.model.row(path)?.review ?? null;
    const existingPr = existing?.pr;
    const replacingPr = typeof raw?.number === "number" && raw.number > 0 && existingPr != null && raw.number !== existingPr.number;
    if (existingPr && existingPr.state !== "merged" && existingPr.state !== "closed" && !replacingPr) return;
    if (!raw || typeof raw.number !== "number" || raw.number <= 0) {
      if (branch !== null && (existing === null || !reviewIsOpen(existing))) this.host.model.learn(path, { reviewBranch: branch, pr: null });
      return;
    }
    const state = raw.state === "draft" || raw.state === "open" || raw.state === "merged" || raw.state === "closed" ? raw.state : raw.isDraft === false ? "open" : "draft";
    const isDraft = typeof raw.isDraft === "boolean" ? raw.isDraft : state === "draft";
    const authorLogin = typeof raw.authorLogin === "string" && raw.authorLogin !== "" ? raw.authorLogin : this.host.deps.viewerLogin() || undefined;
    const pr: PrInfo = {
      number: raw.number,
      url: typeof raw.url === "string" ? raw.url : "",
      state,
      isDraft,
      ...(authorLogin ? { authorLogin } : {}),
      ...(Array.isArray(raw.requestedReviewers) ? { requestedReviewers: raw.requestedReviewers.filter((one): one is string => typeof one === "string") } : {}),
      ...(raw.group ? { group: raw.group } : {}),
      ...(raw.mergeableState ? { mergeableState: raw.mergeableState } : {}),
      ...(raw.reviewPolicy ? { reviewPolicy: raw.reviewPolicy } : {}),
    };
    const fallbackBranch = existing !== null && reviewIsOpen(existing) && !replacingPr ? existing.reviewBranch : null;
    this.host.model.learn(path, { reviewBranch: branch ?? fallbackBranch, pr });
  }

  async accepted(path: string, text: string, body: string, base: string | null = null, answer?: Record<string, unknown> | null): Promise<boolean> {
    const held = heldBy(answer);
    const returned = returnedBy(answer);
    const merged = returned !== null && stripBom(toLf(returned)) !== stripBom(toLf(body)) ? withBomAndEol(toLf(returned), text) : body;
    const remembered = held !== null ? ("text" in held ? held.text : null) : (returned ?? body);
    const commit = typeof answer?.commitSha === "string" && answer.commitSha !== "" ? answer.commitSha : undefined;
    const to = reviewKey(answer?.pr as { number?: unknown; group?: unknown } | null | undefined) ?? this.host.model.reviewOf(path);
    if (await this.writeAndRemember(path, text, merged, remembered, base, to, commit, held !== null)) {
      if (held !== null && "sha" in held) {
        this.forget(path);
        this.host.model.learnSent(path, held.sha, to);
      }
      this.learnFromAnswer(path, answer);
      return true;
    }
    this.rememberLocally(path, text, to, commit);
    if (this.host.model.sentSha(path) === null && this.host.model.row(path)?.change.kind === "new") {
      const uploadedSha = (typeof answer?.contentSha === "string" && answer.contentSha !== "" ? answer.contentSha : null) ?? (remembered !== null ? gitBlobShaOfText(toLf(remembered)) : null);
      if (uploadedSha !== null) this.host.model.learnSent(path, uploadedSha, to);
    }
    this.learnFromAnswer(path, answer);
    return false;
  }

  async writeAndRemember(path: string, mine: string, merged: string, remembered: string | null, base: string | null = null, to?: ReviewKey | null, commit?: string, same = false): Promise<boolean> {
    let held = mine;
    if (stripBom(toLf(merged)) !== stripBom(toLf(mine))) {
      const wrote = await this.write(path, merged, mine);
      if (wrote === false) return false;
      held = typeof wrote === "string" ? wrote : merged;
      await this.host.deps.bringFor?.(path, held).catch(() => undefined);
    }
    if (remembered !== null) await this.remember(path, remembered, to, held, commit, same);
    if (base !== null) this.host.model.rebased(path, base);
    return true;
  }
}
