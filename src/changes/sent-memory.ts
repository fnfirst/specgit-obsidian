import { toLf } from "../disk/line-endings";
import { gitBlobShaOfText } from "./blob-sha";
import { blobShasOf } from "./flow-helpers";
import type { FlowDeps } from "./flow-deps";
import type { ChangeRow, ChangesModel } from "./model";
import { type ReviewKey, reviewKey, sentToThis } from "./review-key";

export interface SentMemoryHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
}

function heldBy(answer: Record<string, unknown> | null | undefined): { text: string } | { sha: string } | null {
  if (answer?.unchanged !== true) return null;
  const sha = typeof answer.contentSha === "string" && answer.contentSha !== "" ? answer.contentSha : null;
  const source = typeof answer.source === "string" ? answer.source : null;
  if (source !== null && (sha === null || gitBlobShaOfText(source) === sha)) return { text: source };
  return sha !== null ? { sha } : null;
}

export class SentMemory {
  constructor(
    private readonly host: SentMemoryHost,
    private readonly write: (path: string, text: string, expected: string) => Promise<boolean> = (path, text, expected) => host.deps.writeText(path, text, expected),
    private readonly sentText: Map<string, { text: string; to: ReviewKey | null; commit?: string }> = new Map(),
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
    for (const [path, text] of sent) {
      const commit = held?.get(path)?.commit;
      this.sentText.set(path, { text, to: review(path), ...(commit === undefined ? {} : { commit }) });
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
    const kept = this.sentText.get(path);
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
    if (name === undefined) return true;
    const key = `${row.doc.repo}\n${name}\n${commit}`;
    if (this.heldCommits.has(key)) return true;
    const seen = await this.host.deps.review.mergePreview(row.doc, name, this.host.deps.publishedBranch, commit);
    if (!seen.ok) return null;
    const answer = (seen.body as { holds?: unknown } | null)?.holds;
    if (answer === undefined) return true;
    if (answer === true) this.heldCommits.add(key);
    return typeof answer === "boolean" ? answer : null;
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
    const commit = typeof answer?.commitSha === "string" && answer.commitSha !== "" ? answer.commitSha : undefined;
    const to = reviewKey(answer?.pr as { number?: unknown; group?: unknown } | null | undefined) ?? this.host.model.reviewOf(path);
    if (await this.writeAndRemember(path, text, body, held === null ? body : "text" in held ? held.text : null, base, to, commit, held !== null)) {
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
