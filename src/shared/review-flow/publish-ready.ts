import { describePublishBlock } from "./publish-policy";
import { classifyRefusal, refusalWords } from "./refusal";
import type { PrMergeableState, PrReviewPolicy, PrState } from "./pr-info";

export interface PublishablePr {
  state: PrState;
  isDraft: boolean;
  mergeable: boolean | null;
  mergeableState: PrMergeableState | null;
  autoMergeEnabled: boolean;
  reviewPolicy?: PrReviewPolicy | null;
}

export function unpublishedNotesReason(names: string[]): string {
  return `This board points at notes that aren't published yet (${names.join(", ")}). Publish them together with the board.`;
}

export function publishReason(pr: PublishablePr, err?: { message?: string; code?: string }, branch = "the published branch"): string {
  if (pr.state === "merged") {
    return "This pull request is already merged. Your changes are live.";
  }
  if (pr.isDraft) {
    return "This hasn't been submitted for review yet. Submit it first.";
  }
  if (pr.mergeableState === "dirty") {
    return "This review conflicts with the published version. Resolve the conflicts on GitHub, then try again.";
  }
  const block = describePublishBlock(pr.mergeableState, pr.reviewPolicy, pr.autoMergeEnabled);
  if (block) return block.detail;
  if (err?.message) return refusalWords(classifyRefusal(err, pr), branch, err.message);
  if (pr.mergeable === false) {
    return "This pull request can't be merged yet. Check the pull request on GitHub for details.";
  }
  return "This document can't be published yet. Check the pull request on GitHub and try again.";
}

export function canMergeNow(pr: Pick<PublishablePr, "state" | "isDraft" | "mergeable" | "mergeableState">): boolean {
  if (pr.state === "merged" || pr.isDraft) return false;
  if (pr.mergeableState === "dirty" || pr.mergeableState === "blocked") return false;
  return pr.mergeable !== false;
}
