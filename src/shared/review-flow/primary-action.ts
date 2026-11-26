import type { PrInfo } from "./pr-info";
import { CLOSE_REVIEW_LABEL, viewerCanApprove } from "./review-state";

export type PrimaryKind = "submit" | "publish" | "approve" | "published" | "propose" | "resolve" | "discard";

export function resolvePrimary(
  pr: PrInfo | null,
  liveBranch: string | null,
  viewerLogin: string,
  canResolve: boolean,
  upstream?: { owner: string; repo: string } | null,
): { kind: PrimaryKind; label: string } {
  if (liveBranch || pr?.state === "merged") {
    return { kind: "published", label: "Published" };
  }
  if (pr?.emptyDiff && (pr.state === "open" || pr.state === "draft")) {
    return { kind: "discard", label: `${CLOSE_REVIEW_LABEL}…` };
  }
  if (upstream) {
    return { kind: "propose", label: `Propose to ${upstream.owner}/${upstream.repo}` };
  }
  if (!pr || pr.isDraft || pr.state === "draft") {
    return { kind: "submit", label: "Submit for review…" };
  }
  if (canResolve && pr.mergeableState === "dirty") return { kind: "resolve", label: "Resolve conflicts…" };
  if (viewerCanApprove(pr, viewerLogin)) {
    return { kind: "approve", label: "Approve" };
  }
  return { kind: "publish", label: "Publish…" };
}
