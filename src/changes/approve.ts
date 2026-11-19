import { noteName } from "../mapping";
import type { StepResult } from "../review/review-api";
import {
  approveConfirm,
  approved,
  APPROVE_FAILED,
  BUSY_WORDS,
  REVIEW_NOT_ACCEPTED,
  ASK_CHANGES_FAILED,
  ASK_CHANGES_PROMPT,
  ASK_CHANGES_SENT,
  groupApproveWords,
  type ItemOutcome,
  NOT_EVERYTHING_WENT_THROUGH,
  outcomeLine,
  type PrInfo,
} from "../shared/review-flow";
import type { Dialogs, FlowDeps } from "./flow-deps";
import { failure } from "./flow-helpers";
import type { ChangeRow, Doing } from "./model";

export interface ApproveHost {
  readonly deps: FlowDeps;

  readUnits(asked: readonly ChangeRow[]): Promise<ChangeRow[]>;

  filesOf(unit: ChangeRow): ChangeRow[];
  busy<T>(work: () => Promise<T>, doing: Doing): Promise<T>;
  alert(options: Parameters<Dialogs["alert"]>[0]): Promise<void>;
  refusal(result: Extract<StepResult, { ok: false }>, doc: ChangeRow["doc"], fallback: string): string;
}

export class ApproveFlows {
  constructor(private readonly host: ApproveHost) {}

  async approve(asked: readonly ChangeRow[]): Promise<ItemOutcome[]> {
    const rows = await this.host.readUnits(asked);
    if (rows.length === 0) return [];
    const words = this.confirmWords(rows);
    const ok = await this.host.deps.dialogs.confirm({ title: words.title, description: words.description, confirmLabel: words.confirm });
    if (!ok) return [];
    return this.host.busy(() => this.each(rows, "approve", undefined, APPROVE_FAILED), { words: BUSY_WORDS.approve, paths: this.pathsOf(rows), kind: "approve" });
  }

  async askForChanges(asked: readonly ChangeRow[]): Promise<ItemOutcome[]> {
    const rows = await this.host.readUnits(asked);
    if (rows.length === 0) return [];
    const note = await this.host.deps.dialogs.askNote({
      title: ASK_CHANGES_PROMPT.title,
      description: ASK_CHANGES_PROMPT.description,
      label: ASK_CHANGES_PROMPT.label,
      placeholder: ASK_CHANGES_PROMPT.placeholder,
      confirmLabel: ASK_CHANGES_PROMPT.confirm,
      required: ASK_CHANGES_PROMPT.required,
    });
    if (note === null) return [];
    return this.host.busy(() => this.each(rows, "request_changes", note, ASK_CHANGES_FAILED), { words: BUSY_WORDS["ask-changes"], paths: this.pathsOf(rows) });
  }

  private autoMerges(row: ChangeRow): boolean {
    return row.review?.pr?.autoMergeEnabled === true;
  }

  private pathsOf(rows: readonly ChangeRow[]): string[] {
    return rows.flatMap((row) => this.host.filesOf(row).map((file) => file.change.path));
  }

  private confirmWords(rows: readonly ChangeRow[]): { title: string; description: string; confirm: string } {
    const one = rows[0]!;
    const asking = approveConfirm(rows.length, "note", rows.length === 1 && this.autoMerges(one));
    if (rows.length === 1 && one.group) return { ...groupApproveWords({ name: one.group.overview.name, files: one.group.files.length }), confirm: asking.confirm };
    return asking;
  }

  private async each(rows: readonly ChangeRow[], verdict: "approve" | "request_changes", note: string | undefined, failedTitle: string): Promise<ItemOutcome[]> {
    const outcomes: ItemOutcome[] = [];
    for (const row of rows) {
      const result = await this.host.deps.review.review(row.doc, verdict, note);
      const path = row.change.path;
      if (result.ok) {
        this.learn(row, result.body.pr as PrInfo | undefined);
        outcomes.push({ path, status: "done" });
      } else {
        outcomes.push({ path, status: "failed", reason: this.host.refusal(result, row.doc, REVIEW_NOT_ACCEPTED) || failure(result, REVIEW_NOT_ACCEPTED) });
      }
    }
    const failed = outcomes.filter((one) => one.status !== "done");
    const nameOf = (path: string): string => noteName(path);
    if (failed.length > 0) {

      if (rows.length === 1) await this.host.alert({ title: failedTitle, description: (failed[0] as { reason: string }).reason });
      else await this.host.alert({ title: NOT_EVERYTHING_WENT_THROUGH, description: outcomes.map((one) => outcomeLine(one, nameOf)).join("\n") });
    }
    if (failed.length < outcomes.length) {

      const done = verdict === "request_changes" ? ASK_CHANGES_SENT : approved(rows.length === 1 && this.autoMerges(rows[0]!));
      this.host.deps.dialogs.toast(done.title, done.description);
    }
    return outcomes;
  }

  private learn(unit: ChangeRow, pr: PrInfo | undefined): void {
    if (!pr) return;
    for (const file of this.host.filesOf(unit)) {
      const was = file.review?.pr;
      this.host.deps.model.learn(file.change.path, { reviewBranch: file.review?.reviewBranch ?? null, pr: { ...was, ...pr, ...(was?.group ? { group: was.group } : {}) } });
    }
  }
}
