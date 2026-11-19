import type { PrMergeableState, PrReviewPolicy } from "./pr-info";

export interface PublishBlock {
  kind: "reviews" | "changes_requested" | "checks" | "unknown";

  label: string;

  title: string;

  detail: string;
}

export const CHECKS_WAIT = "GitHub is running this repo's required checks. Publishing unlocks when they pass.";

export const PUBLISH_BLOCK_LABEL = {
  auto: "Publishes when approved",
  review: "Waiting on review",
  changes: "Changes requested",
  checks: "Waiting on checks",
  unknown: "Blocked on GitHub",
} as const;

export function describePublishBlock(
  mergeableState: PrMergeableState | null | undefined,
  policy: PrReviewPolicy | null | undefined,
  autoPublish = false,
): PublishBlock | null {
  if (mergeableState !== "blocked") return null;
  if (autoPublish) {
    const onChecks = policy?.reviewDecision === "approved" || policy?.reviewDecision === null;
    return {
      kind: onChecks ? "checks" : "reviews",
      label: PUBLISH_BLOCK_LABEL.auto,
      title: "Publishes when approved",
      detail: onChecks
        ? "Automatic publish is on. This is published as soon as GitHub finishes its required checks."
        : "Automatic publish is on. This is published as soon as a teammate approves.",
    };
  }
  switch (policy?.reviewDecision) {
    case "review_required":
      return {
        kind: "reviews",
        label: PUBLISH_BLOCK_LABEL.review,
        title: "Waiting on review approval",
        detail: `${requiredApprovalsSentence(policy)} Ask a teammate to approve it, then publish.`,
      };
    case "changes_requested":
      return {
        kind: "changes_requested",
        label: PUBLISH_BLOCK_LABEL.changes,
        title: "Changes requested",
        detail:
          "A reviewer asked for changes. You can publish once they approve your update.",
      };
    case "approved":
    case null:

      return {
        kind: "checks",
        label: PUBLISH_BLOCK_LABEL.checks,
        title: "Waiting on GitHub checks",
        detail: CHECKS_WAIT,
      };
    default:

      return {
        kind: "unknown",
        label: PUBLISH_BLOCK_LABEL.unknown,
        title: "Can't publish yet",
        detail: "GitHub is waiting on a required review or check before this can be published.",
      };
  }
}

function requiredApprovalsSentence(policy: PrReviewPolicy): string {
  const n = policy.requiredApprovals;
  if (n === null) return "This repo requires an approving review before this can be published.";
  const codeOwner = policy.requiresCodeOwnerReview ? " (including a code owner)" : "";
  return `Publishing needs ${n} approving review${n === 1 ? "" : "s"}${codeOwner}: ${policy.approvals} so far.`;
}
