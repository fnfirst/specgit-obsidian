import type { BranchFile } from "../auth/git-copy";
import { stripBom, toLf, withBomAndEol } from "../disk/line-endings";
import { reviewIsOpen, type ReviewStatus } from "../review/review-api";
import { isGroupBranch } from "../shared/review-flow";
import { draftWriter, follows } from "../stay/draft-state";
import type { SendHooks } from "../stay/types";
import { gitBlobShaOfText } from "./blob-sha";
import type { FlowDeps } from "./flow-deps";
import { type AutoCommitOutcome, autoOutcome, type AutoStepOutcome, type Carried, MOVED_ATTEMPTS, type Sent } from "./flow-helpers";
import { MemberSync } from "./member-sync";
import type { ChangeRow, ChangesModel } from "./model";
import type { ReadBacks } from "./read-back";
import type { SentMemory } from "./sent-memory";

export type FileRow = Pick<ChangeRow, "doc" | "review"> & { change: { path: string } };

export interface SendOptions {
  toReview?: boolean;
  quiet?: boolean;
  afresh?: boolean;
  carried?: Carried;
  auto?: { deps: FlowDeps; memory: SentMemory };
  edit?: boolean;
  branch?: string;
  found?: BranchFile;
  viaGroup?: true;
  stopOnBehind?: boolean;
}

export interface AutoCommitHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
  readonly backs: ReadBacks;
  readonly memory: SentMemory;
  readonly meter: { writes: number };
  readonly goneAt: Map<string, number>;
  isClosingDeletedDraft(path: string): boolean;
  sendOnce(row: ChangeRow, options: SendOptions): Promise<Sent>;
  sendAttachmentsAlone(row: FileRow, deps: FlowDeps): Promise<Sent | null>;
}

export class AutoCommitFlows {
  constructor(private readonly host: AutoCommitHost) {}

  async autoCommit(row: ChangeRow, isCurrent: () => boolean, hooks?: SendHooks): Promise<AutoCommitOutcome> {
    if (hooks !== undefined && row.change.kind !== "deleted" && !this.host.model.hasRepoFile(row.change.path) && this.host.isClosingDeletedDraft(row.change.path)) {
      return { result: "later", writes: 0 };
    }
    const before = this.host.meter.writes;
    this.host.goneAt.delete(row.change.path);
    const outcome = hooks?.edit ? (this.host.model.groupOf(row.change.path) ? await this.autoMember(row, isCurrent, hooks) : await this.autoEdited(row, isCurrent, hooks)) : await this.autoCommitted(row, isCurrent);
    return {
      result: outcome.result,
      writes: this.host.meter.writes - before,
      ...(outcome.inVault === false ? { inVault: false as const } : {}),
      ...(outcome.result === "deleted" && this.host.goneAt.has(row.change.path) ? { deletedAt: this.host.goneAt.get(row.change.path)! } : {}),
      ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
    };
  }

  async autoAttachments(row: ChangeRow, isCurrent: () => boolean, hooks: SendHooks): Promise<{ result: "done" | "later" | "limited"; writes: number; retryAfterMs?: number }> {
    const { deps } = this.quiet(hooks);
    const before = this.host.meter.writes;
    const outcome = await this.sendLeftBehind(row, isCurrent, deps);
    return { result: outcome.result, writes: this.host.meter.writes - before, ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }) };
  }

  private async sendLeftBehind(row: ChangeRow, isCurrent: () => boolean, deps: FlowDeps): Promise<{ result: "done" | "later" | "limited"; retryAfterMs?: number }> {
    if (!isCurrent()) return { result: "later" };
    const status = await this.host.deps.review.status(row.doc);
    if (status === null) return { result: "later" };
    if (!reviewIsOpen(status)) return { result: "done" };
    const sent = await this.host.sendAttachmentsAlone({ ...row, review: status }, deps);
    if (sent === null) return { result: "done" };
    return "limited" in sent && sent.limited ? { result: "limited", ...(sent.retryAfterMs === undefined ? {} : { retryAfterMs: sent.retryAfterMs }) } : { result: "later" };
  }

  private async autoCommitted(row: ChangeRow, isCurrent: () => boolean): Promise<AutoStepOutcome> {
    for (let attempt = 1; attempt <= MOVED_ATTEMPTS; attempt++) {
      if (!isCurrent()) return { result: "retry" };
      const outcome = autoOutcome(await this.host.sendOnce(row, { quiet: true }), { retryMoved: true });
      if (outcome !== null) return outcome;
    }
    return { result: "retry" };
  }

  private quiet(hooks: SendHooks): { deps: FlowDeps; memory: SentMemory; conflicted: () => boolean } {
    let conflicted = false;
    const deps: FlowDeps = {
      ...this.host.deps,
      chooseWhatToKeep: async () => {
        conflicted = true;
        return null;
      },
    };
    const memory = this.host.memory.writingWith(async (path, text, expected) => {
      let finalText = text;
      const written =
        (await hooks.during(
          [path],
          () =>
            this.host.deps.vault.process(path, (current) => {
              if (current !== expected && stripBom(current) !== expected) return null;
              finalText = withBomAndEol(toLf(text), current);
              return finalText;
            }),
          (result) => (result === "written" ? { [path]: gitBlobShaOfText(finalText) } : null),
        )) === "written";
      if (!written) hooks.notWritten(path);
      return written ? finalText : false;
    });
    return { deps, memory, conflicted: () => conflicted };
  }

  private canAutoSaveToHead(path: string, headSha: string, status: ReviewStatus, policy: SendHooks["policy"], inGroup = false): boolean {
    if (policy !== "mine") return true;
    const sentSha = this.host.model.sentSha(path);
    const sentTo = this.host.model.sentTo(path);
    const known = this.host.model.draftFor(path);
    const prNumber = status.pr?.number ?? known?.prNumber ?? null;
    const matched = known !== undefined && known.blob === headSha;
    const draft = {
      by: matched ? known.by : null,
      lastBy: matched ? draftWriter(known) : null,
      blob: headSha,
      prNumber,
      ...(inGroup || status.pr?.group ? { inGroup: true as const } : {}),
    };
    return follows(draft, this.host.deps.viewerLogin(), { ...(sentSha !== null ? { sent: sentSha } : {}), ...(sentTo !== null ? { sentTo } : {}) }, "mine");
  }

  private async autoMember(row: ChangeRow, isCurrent: () => boolean, hooks: SendHooks): Promise<AutoStepOutcome> {
    const { deps, memory, conflicted } = this.quiet(hooks);
    if (!isCurrent()) return { result: "retry" };
    if (!hooks.memberBranch) return { result: "held" };
    if (isGroupBranch(hooks.memberBranch)) return this.autoViaGroup(row, isCurrent, hooks, hooks.memberBranch);
    const status = await this.host.deps.review.status(row.doc);
    if (status === null) return { result: "later" };
    if (status.reviewBranch !== hooks.memberBranch || !reviewIsOpen(status)) return { result: "held" };
    if (hooks.policy === "mine") {
      const found = await this.host.deps.branchFile(row.doc, status.reviewBranch);
      if (found.kind === "unreadable") return { result: "later" };
      if (found.kind === "absent") return { result: "held" };
      if (!this.canAutoSaveToHead(row.change.path, found.sha, status, hooks.policy, true)) return { result: "later" };
    }
    const attachments = await this.host.sendAttachmentsAlone({ ...row, review: status }, deps);
    if (attachments !== null) return autoOutcome(attachments) ?? { result: "retry" };
    const members = new MemberSync({ deps, backs: this.host.backs, memory, ...(hooks.policy === "mine" ? { stopOnBehind: true } : {}), send: async () => ({ ok: false, held: true }) });
    const sent = await members.syncAll([{ ...row, review: status }], "its group");
    return autoOutcome(sent, { conflicted: conflicted() }) ?? { result: "retry" };
  }

  private async autoViaGroup(row: ChangeRow, isCurrent: () => boolean, hooks: SendHooks, groupBranch: string): Promise<AutoStepOutcome> {
    const { deps, memory, conflicted } = this.quiet(hooks);
    for (let attempt = 1; attempt <= MOVED_ATTEMPTS; attempt++) {
      if (!isCurrent()) return { result: "retry" };
      const status = await this.host.deps.review.status(row.doc);
      if (status === null) return { result: "later" };
      if (!reviewIsOpen(status)) return { result: "held" };
      const found = await this.host.deps.branchFile(row.doc, groupBranch);
      if (found.kind === "unreadable") return { result: "later" };
      if (found.kind === "absent") return { result: "held" };
      if (!this.canAutoSaveToHead(row.change.path, found.sha, status, hooks.policy, true)) return { result: "later" };
      const sent = await this.host.sendOnce({ ...row, review: status }, { quiet: true, auto: { deps, memory }, ...(hooks.policy === "mine" ? { stopOnBehind: true } : {}), toReview: true, branch: groupBranch, found, viaGroup: true });
      const outcome = autoOutcome(sent, { conflicted: conflicted(), retryMoved: true });
      if (outcome !== null) return outcome;
    }
    return { result: "retry" };
  }

  private async autoEdited(row: ChangeRow, isCurrent: () => boolean, hooks: SendHooks): Promise<AutoStepOutcome> {
    const { deps, memory, conflicted } = this.quiet(hooks);
    for (let attempt = 1; attempt <= MOVED_ATTEMPTS; attempt++) {
      if (!isCurrent()) return { result: "retry" };
      const status = await this.host.deps.review.status(row.doc);
      if (status === null) return { result: "later" };
      const draft = reviewIsOpen(status) ? status.reviewBranch : null;
      if (draft === null) {
        if (hooks.ended === true) return { result: "later" };
        if (this.host.model.sentSha(row.change.path) !== null) {
          if (!this.host.model.wasRecentlyClosedDraft(row.change.path)) return { result: "later" };
          this.host.model.learnSent(row.change.path, null);
        }
      }
      let found: BranchFile | undefined;
      if (draft !== null) {
        found = await this.host.deps.branchFile(row.doc, draft);
        if (found.kind === "unreadable") return { result: "later" };
        if (found.kind === "absent") return { result: "held" };
        if (!this.canAutoSaveToHead(row.change.path, found.sha, status, hooks.policy, false)) return { result: "later" };
      }
      const sent = await this.host.sendOnce(row, { quiet: true, auto: { deps, memory }, ...(hooks.policy === "mine" ? { stopOnBehind: true } : {}), ...(draft !== null ? { toReview: true, branch: draft, found: found! } : { edit: row.change.kind === "edited" }) });
      const outcome = autoOutcome(sent, { conflicted: conflicted(), retryMoved: true });
      if (outcome !== null) return outcome;
    }
    return { result: "retry" };
  }
}
