import { changeSetCounts, changeSetScope, reviewStage, waitsOnViewer, type ChangeSet, type ChangeSetEntry, type ReviewStage } from "./change-set";
import type { PrInfo } from "./pr-info";
import { describePublishBlock, type PublishBlock } from "./publish-policy";

export type ReviewTone = "muted" | "info" | "danger";

export type ReviewIcon = "alert-triangle" | "check" | "circle-dashed" | "git-pull-request" | "hourglass" | "message-square-warning" | "rocket" | "send" | "shield-check" | "user-check";

export interface ReviewState {
  kind: ReviewStage | "published" | "none";
  label: string;
  short: string;
  icon: ReviewIcon;
  tone: ReviewTone;
  title: string;
}

const BLOCK_ICON: Record<PublishBlock["kind"], ReviewIcon> = {
  reviews: "user-check",
  changes_requested: "message-square-warning",
  checks: "hourglass",
  unknown: "hourglass",
};

const notLiveDraft = (pr: number): string => `Draft, not sent for review yet (pull request #${pr}). Your edits are added to it when you submit or publish, or as you type once you connect live.`;

function stageState(
  stage: ReviewStage,
  { block, yourReview, requested, pr, savesAsYouType = true, approved = false }: { block: PublishBlock | null; yourReview: boolean; requested: readonly string[]; pr: number; savesAsYouType?: boolean; approved?: boolean },
): ReviewState {
  const said = (text: string) => `${text.replace(/\.$/, "")} (pull request #${pr}).`;
  if (yourReview) return { kind: stage, label: "Your review", short: "Your review", icon: "user-check", tone: "info", title: said("Waiting on your review") };
  switch (stage) {
    case "conflicts":
      return { kind: stage, label: "Conflicts", short: "Conflicts", icon: "alert-triangle", tone: "danger", title: said("This review conflicts with the published file. Resolve the conflicts to publish") };
    case "in_progress":
      return { kind: stage, label: "In progress", short: "In progress", icon: "git-pull-request", tone: "muted", title: savesAsYouType ? `Draft, not sent for review yet. Your edits are saved to it as you type (pull request #${pr}).` : notLiveDraft(pr) };
    case "waiting":
      return {
        kind: stage,
        label: block?.label ?? "Waiting on review",
        short: "Waiting",
        icon: block ? BLOCK_ICON[block.kind] : "hourglass",
        tone: "muted",
        title: said(block?.detail ?? "Waiting on a required review or check"),
      };
    case "auto_publish":
      return { kind: stage, label: "Auto-publish", short: "Auto-publish", icon: "rocket", tone: "muted", title: said(block?.detail ?? "Publishes by itself once it's approved") };
    case "in_review":
      return requested.length
        ? { kind: stage, label: "In review", short: "In review", icon: "git-pull-request", tone: "muted", title: said(`Asked: ${requested.join(", ")}. Nothing blocks publishing`) }
        : { kind: stage, label: "Ready to publish", short: "Ready", icon: "rocket", tone: "info", title: said(approved ? "Approved. Publish when you like" : "Nothing blocks publishing") };
    default: {
      const _exhaustive: never = stage;
      return _exhaustive;
    }
  }
}

export function publishedState(branch: string | null): ReviewState {
  return {
    kind: "published",
    label: "Published",
    short: "Published",
    icon: "check",
    tone: "muted",
    title: branch ? `Your changes are live on ${branch}` : "Your changes are live",
  };
}

export const PENDING_REVIEW_LABEL = "Saved, not in review yet";
export const EMPTY_REVIEW_LABEL = "No changes to publish";
export const EMPTY_REVIEW_DETAIL = "This review matches the published file, so there is nothing to publish.";
export const CLOSE_REVIEW_LABEL = "Close review";

const NONE: ReviewState = { kind: "none", label: "Up to date", short: "Up to date", icon: "circle-dashed", tone: "muted", title: "No open review" };
const PENDING: ReviewState = {
  kind: "in_progress",
  label: PENDING_REVIEW_LABEL,
  short: PENDING_REVIEW_LABEL,
  icon: "git-pull-request",
  tone: "muted",
  title: "Saved, not in review yet. Submit for review when you're ready.",
};

function docStage(pr: PrInfo) {
  return {
    stage: reviewStage({ ...pr, isDraft: pr.isDraft || pr.state === "draft" }),
    block: pr.state === "open" ? describePublishBlock(pr.mergeableState, pr.reviewPolicy, pr.autoMergeEnabled) : null,
    authorLogin: pr.authorLogin ?? null,
  };
}

export function viewerCanApprove(pr: PrInfo | null, viewerLogin: string): boolean {
  return pr !== null && pr.state === "open" && !pr.emptyDiff && waitsOnViewer(docStage(pr), viewerLogin);
}

export function fileReviewState(
  pr: PrInfo | null,
  liveBranch: string | null,
  viewerLogin: string,
  options: { savesAsYouType?: boolean; pending?: boolean } = {},
): ReviewState {
  if (liveBranch || pr?.state === "merged") return publishedState(liveBranch ?? pr?.baseRef ?? null);
  if (!pr || pr.state === "closed") return options.pending ? PENDING : NONE;
  const doc = docStage(pr);
  if (pr.emptyDiff) {
    return {
      kind: doc.stage,
      label: EMPTY_REVIEW_LABEL,
      short: "No changes",
      icon: "circle-dashed",
      tone: "muted",
      title: EMPTY_REVIEW_DETAIL,
    };
  }
  return stageState(doc.stage, {
    block: doc.block,
    yourReview: viewerCanApprove(pr, viewerLogin),
    requested: pr.requestedReviewers ?? [],
    pr: pr.number,
    approved: pr.reviewPolicy?.reviewDecision === "approved",
    ...options,
  });
}

export function entryReviewState(entry: ChangeSetEntry, viewerLogin: string): ReviewState {
  return stageState(entry.stage, { block: entry.block, yourReview: waitsOnViewer(entry, viewerLogin), requested: entry.requestedReviewers, pr: entry.prNumber });
}

export function changeSetReviewState(set: ChangeSet, viewerLogin: string): ReviewState | null {
  const scope = changeSetScope(set);
  if (!scope || !set.stage) return null;
  const pick =
    set.entries.find((e) => e.stage === "conflicts") ??
    set.entries.find((e) => waitsOnViewer(e, viewerLogin)) ??
    set.entries.find((e) => e.stage === set.stage)!;
  return { ...entryReviewState(pick, viewerLogin), title: `${scope}: ${changeSetCounts(set)}.` };
}

export interface StatusBadge {
  label: string;
  tone: ReviewTone;
  icon: ReviewIcon;
  title: string;
  count?: number;
  done: boolean;
  idle: boolean;
}

function badgeOf(state: ReviewState, count?: number): StatusBadge {
  const inReview = state.kind !== "none" && state.kind !== "published";
  return {
    label: state.label,
    tone: state.tone,
    icon: state.icon,
    title: state.title,
    count: inReview && count && count > 1 ? count : undefined,
    done: state.kind === "published",
    idle: state.kind === "none",
  };
}

export function statusBadge(state: ReviewState | null, opts: { publishedHere: boolean; count?: number }): StatusBadge {
  return badgeOf(!state || (state.kind === "published" && !opts.publishedHere) ? NONE : state, opts.count);
}

export function changeSetBadge(set: ChangeSet, viewerLogin: string, publishedCount: number, publishedBranch: string): StatusBadge {
  const state = changeSetReviewState(set, viewerLogin) ?? (publishedCount ? publishedState(publishedBranch) : null);
  return statusBadge(state, { publishedHere: true, count: set.entries.length });
}

export function rowBadge(state: ReviewState): StatusBadge {
  return { ...badgeOf(state), label: state.short };
}

export const STEP_ICON = { submit: "send", approve: "user-check", publish: "rocket" } as const satisfies Record<string, ReviewIcon>;

export function actionWords(kind: "submit" | "approve" | "publish", count: number): string {
  const n = count === 1 ? "" : ` ${count}`;
  switch (kind) {
    case "submit":
      return `Submit${n} for review`;
    case "approve":
      return `Approve${n}`;
    case "publish":
      return `Publish${n}`;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export const submitLabel = (count: number): string => `${actionWords("submit", count)}…`;
