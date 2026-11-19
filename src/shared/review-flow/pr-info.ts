export type PrReviewDecision = "approved" | "changes_requested" | "review_required";

export interface PrReviewPolicy {
  reviewDecision: PrReviewDecision | null;

  approvals: number;

  requiredApprovals: number | null;

  requiresCodeOwnerReview: boolean;
}

export type PrState = "draft" | "open" | "merged" | "closed";

export type PrMergeableState = "clean" | "dirty" | "blocked" | "unknown";

export interface GroupLabel {
  name: string;
  files: number;
}

export interface PrInfo {

  closedBy?: string | null;

  viewerWrote?: boolean | "unknown";
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  baseRef?: string;
  mergeable?: boolean | null;
  mergeableState?: PrMergeableState | null;

  reviewPolicy?: PrReviewPolicy | null;

  authorLogin?: string | null;

  autoMergeEnabled?: boolean;

  requestedReviewers?: string[];

  group?: GroupLabel;
}
