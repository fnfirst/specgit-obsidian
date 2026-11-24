import type { BranchFile } from "../auth/git-copy";
import { reviewIsOpen } from "../review/review-api";
import { isGroupBranch } from "../shared/review-flow";
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
}

export interface AutoCommitHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
  readonly backs: ReadBacks;
  readonly memory: SentMemory;
  readonly meter: { writes: number };
  readonly goneAt: Map<string, number>;
  sendOnce(row: ChangeRow, options: SendOptions): Promise<Sent>;
  sendAttachmentsAlone(row: FileRow, deps: FlowDeps): Promise<Sent | null>;
}

export class AutoCommitFlows {
  constructor(private readonly host: AutoCommitHost) {}

  async autoCommit(row: ChangeRow, isCurrent: () => boolean, hooks?: SendHooks): Promise<AutoCommitOutcome> {
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
      const written = (await hooks.during([path], () => this.host.deps.vault.process(path, (current) => (current === expected ? text : null)), (result) => (result === "written" ? { [path]: gitBlobShaOfText(text) } : null))) === "written";
      if (!written) hooks.notWritten(path);
      return written;
    });
    return { deps, memory, conflicted: () => conflicted };
  }

  private async autoMember(row: ChangeRow, isCurrent: () => boolean, hooks: SendHooks): Promise<AutoStepOutcome> {
    const { deps, memory, conflicted } = this.quiet(hooks);
    if (!isCurrent()) return { result: "retry" };
    if (!hooks.memberBranch) return { result: "held" };
    if (isGroupBranch(hooks.memberBranch)) return this.autoViaGroup(row, isCurrent, hooks, hooks.memberBranch);
    const status = await this.host.deps.review.status(row.doc);
    if (status === null) return { result: "later" };
    if (status.reviewBranch !== hooks.memberBranch || !reviewIsOpen(status)) return { result: "held" };
    const attachments = await this.host.sendAttachmentsAlone({ ...row, review: status }, deps);
    if (attachments !== null) return autoOutcome(attachments) ?? { result: "retry" };
    const members = new MemberSync({ deps, backs: this.host.backs, memory, send: async () => ({ ok: false, held: true }) });
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
      const sent = await this.host.sendOnce({ ...row, review: status }, { quiet: true, auto: { deps, memory }, toReview: true, branch: groupBranch, found, viaGroup: true });
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
      if (draft === null && (hooks.ended === true || this.host.model.sentSha(row.change.path) !== null)) return { result: "later" };
      let found: BranchFile | undefined;
      if (draft !== null) {
        found = await this.host.deps.branchFile(row.doc, draft);
        if (found.kind === "unreadable") return { result: "later" };
        if (found.kind === "absent") return { result: "held" };
      }
      const sent = await this.host.sendOnce(row, { quiet: true, auto: { deps, memory }, ...(draft !== null ? { toReview: true, branch: draft, found: found! } : { edit: row.change.kind === "edited" }) });
      const outcome = autoOutcome(sent, { conflicted: conflicted(), retryMoved: true });
      if (outcome !== null) return outcome;
    }
    return { result: "retry" };
  }
}
