import { describePublishBlock, type PublishBlock } from "./publish-policy";
import type { PrInfo, PrMergeableState } from "./pr-info";
import type { Noun } from "./status-list";

type LifecycleBusy = "submit" | "publish" | "ask-review" | "unsubmit" | "abandon" | "approve" | "ask-changes";

export const BUSY_WORDS: Record<LifecycleBusy, string> = {
  submit: "Submitting…",
  publish: "Publishing…",
  abandon: "Abandoning…",
  "ask-review": "Asking…",
  unsubmit: "Moving back…",
  approve: "Approving…",
  "ask-changes": "Sending…",
};

export interface Words {
  title: string;
  description: string;
}

export const SUBMIT_ONLY_THIS = "Submit only this";
export const PUBLISH_ONLY_THIS = "Publish only this";

export const SUBMIT_STEP = {
  title: "Submit for review",
  reviewers: "Reviewers (optional)",
  note: "Reviewers get a GitHub notification. You can move it back to a draft from here until it's published.",
  back: "Back",
  submit: "Submit",
  addReviewer: "Add a reviewer",
  addAnother: "Add",
} as const;

export function openCommentsWarning(openComments: number, noun: Noun = "document"): string | null {
  return openComments > 0 ? `${openComments} open ${openComments === 1 ? "comment" : "comments"} on this ${noun}.` : null;
}

export const SUBMITTED_TITLE = "Submitted for review";
export const submittedDescription = (reviewers: readonly string[]): string | null => (reviewers.length ? `${reviewers.join(", ")} will get a GitHub notification.` : null);
export const SUBMIT_FAILED = "Couldn't submit for review";
export const ASK_REVIEW_FAILED = "Couldn't ask for review";
export const REVIEW_REQUESTED = (login: string): Words => ({ title: "Review requested", description: `${login} was asked to review this document.` });
export const ADD_REVIEWER_DESCRIPTION = "They'll get a GitHub notification with a link that opens this document right here.";

export const MOVED_BACK: Words = { title: "Moved back to draft", description: "Submit it again when it's ready." };
export const MOVE_BACK_FAILED = "Couldn't move it back to a draft";

export const publishConfirm = (noun: Noun = "document") => ({ title: `Publish this ${noun}?`, description: "Your changes become the official version everyone sees.", confirm: "Publish" }) as const;
export const PUBLISH_CONFIRM = publishConfirm();
export const PUBLISHED: Words = { title: "Published", description: "Your changes are now live." };
export const ALREADY_PUBLISHED: Words = { title: "Already published", description: "This review was already published on GitHub." };
export const VIEW_ON_GITHUB = "View it on GitHub";
export const VIEW_ON_GITHUB_LINK = "View the review on GitHub";
export const VIEW_DRAFT_ON_GITHUB_LINK = "View the draft on GitHub";
export const viewOnGithubLink = (draft: boolean): string => (draft ? VIEW_DRAFT_ON_GITHUB_LINK : VIEW_ON_GITHUB_LINK);

export const ABANDON_REVIEW_ITEM = "Abandon review…";

export const upToDateWords = (branch: string): string => `Up to date with ${branch}. Your next edit starts a draft.`;

export const VIEW_ON_GITHUB_ITEM = "View on GitHub";

export const IDLE_WORDS = { nothing: "Nothing to do for these yet" } as const;

export const stepTitle = (label: string, count: number): string => (count > 1 ? `${label}, each in its own review` : label);
export const PUBLISH_FAILED = "Couldn't publish";
export const COULD_NOT_PUBLISH = "Could not publish";

export const AUTO_PUBLISH_ON: Words = {
  title: "Automatic publish is on",
  description: "This document is published the moment it's approved. You can close the tab. Nothing else to do.",
};
export const AUTO_PUBLISH_FAILED = "Couldn't turn on automatic publish";
export const AUTO_PUBLISH_DECLINED = "GitHub declined. You can still publish manually once it's approved.";

export const MERGE_OFFER = {
  title: "Publish this review?",
  confirm: "Publish",
  description: (number: number | string) => `Review #${number} is ready to publish.`,
} as const;
export const STILL_CANT_PUBLISH = "Still can't publish";
const CANT_PUBLISH_YET = "Can't publish yet";
const ARM_OFFER = { confirm: "Publish when approved", cancel: "Not now", question: "Want it published automatically as soon as that happens?" } as const;

export const ABANDON_CONFIRM = {
  title: "Abandon this review?",
  confirm: "Abandon review",
  description: (comments: string, publishedBranch: string, riff = "") =>
    `Your draft edits will be permanently discarded.${riff ? ` ${riff}` : ""} The review will be closed on GitHub and its branch deleted. ${comments} The published document on ${publishedBranch} is not affected.`,
} as const;
export const approveConfirm = (count: number, noun: Noun = "document", autoMerge = false) =>
  ({
    title: count === 1 ? `Approve this ${noun}?` : `Approve ${count} ${noun}s?`,
    description:
      count === 1
        ? autoMerge
          ? "You're signing off on this version. It's set to publish automatically, so approving makes it go live."
          : "You're signing off on this version. Your approval is recorded, and publishing unlocks once every required approval is in."
        : "You're signing off on these versions. Your approvals are recorded, and each one can be published once every required approval is in.",
    confirm: "Approve",
  }) as const;
export const APPROVE_FAILED = "Couldn't approve";
export const REVIEW_NOT_ACCEPTED = "GitHub didn't accept this review.";
export const approved = (autoMerge: boolean): Words => ({
  title: "Approved",
  description: autoMerge ? "Your sign-off is in. This publishes automatically in a moment." : "Your sign-off is in. Publish unlocks once every required approval is met.",
});
export const ASK_CHANGES_PROMPT = {
  title: "Ask for changes",
  description: "Tell the author what needs another pass. Publishing pauses until you approve an updated version.",
  label: "Note to the author",
  placeholder: "What should change?",
  confirm: "Send",
  required: "Add a short note so the author knows what to change.",
} as const;
export const ASK_CHANGES_SENT: Words = { title: "Sent to the author", description: "Publishing is paused until you approve an updated version." };
export const ASK_CHANGES_FAILED = "Couldn't send that";
export const abandonGroupConfirm = (name: string, files: number, noun: Noun = "document") =>
  ({
    title: `Stop the review of ${name}?`,
    description: `The draft edits of its ${files} ${files === 1 ? noun : `${noun}s`} will be permanently discarded, and the review closes. Comments started in it are marked resolved. The published ${files === 1 ? noun : `${noun}s`} are not affected.`,
    confirm: "Stop the review",
  }) as const;
export const ABANDONED: Words = { title: "Review abandoned", description: "The draft was discarded." };
export const ABANDON_FAILED = "Couldn't abandon the review";

export interface BlockedPublish {
  mergeableState?: PrMergeableState | null;
  canMerge?: boolean;
  reason?: string | null;
  prUrl?: string | null;
  pr?: PrInfo | null;
}

type BlockedDecision =
  | { kind: "resolve" }
  | { kind: "merge"; title: string; description: string; confirm: string }
  | { kind: "arm"; title: string; description: string; confirm: string; cancel: string }
  | { kind: "alert"; title: string; description: string | null | undefined; href: string | null | undefined; hrefLabel: string };

export function decideBlocked(body: BlockedPublish, canResolve: boolean): BlockedDecision {
  const pr = body.pr ?? null;
  if (body.mergeableState === "dirty" && canResolve) return { kind: "resolve" };
  if (body.canMerge) {
    return { kind: "merge", title: MERGE_OFFER.title, description: body.reason || MERGE_OFFER.description(pr?.number ?? ""), confirm: MERGE_OFFER.confirm };
  }
  const block: PublishBlock | null = describePublishBlock(body.mergeableState ?? null, pr?.reviewPolicy, pr?.autoMergeEnabled);
  const approvalGate = block?.kind === "reviews" || block?.kind === "changes_requested";
  if (block && approvalGate && !pr?.autoMergeEnabled) {
    return { kind: "arm", title: block.title, description: `${body.reason ?? block.detail} ${ARM_OFFER.question}`, confirm: ARM_OFFER.confirm, cancel: ARM_OFFER.cancel };
  }
  return { kind: "alert", title: block?.title ?? CANT_PUBLISH_YET, description: body.reason, href: body.prUrl, hrefLabel: VIEW_ON_GITHUB };
}

export const APPROVE_IN_SPECGIT = "Approve in specgit";

export type ItemOutcome = { path: string; status: "done" } | { path: string; status: "waiting" | "failed" | "skipped"; reason: string };

export function outcomeLine(outcome: ItemOutcome, nameOf: (path: string) => string = (path) => path.split("/").pop() ?? path): string {
  const name = nameOf(outcome.path);
  return outcome.status === "done" ? `${name}: done` : `${name}: ${outcome.reason}`;
}

export const NOT_EVERYTHING_WENT_THROUGH = "Some files weren't finished";

const countOf = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

export function outcomesDescription(groups: number, files: number): string {
  return [groups && countOf(groups, "group"), files && countOf(files, "file")].filter(Boolean).join(" and ");
}

export function deletedWords(noun: Noun | "board", path: string, branch: string | null, deletedAssets: number): { title: string; description: string } {
  const assetNote = deletedAssets ? ` ${deletedAssets} unused image${deletedAssets === 1 ? "" : "s"} cleaned up.` : "";
  return { title: noun === "board" ? "Board deleted" : noun === "note" ? "Note deleted" : "Document deleted", description: `${path} was removed${branch ? ` from ${branch}` : ""}.${assetNote}` };
}
export const couldntDeleteTitle = (noun: Noun | "board"): string => `Couldn't delete the ${noun}`;

export const COULDNT_FINISH = "Couldn't finish that";
export const TRY_AGAIN = "Please try again.";

export function setOpenCommentsWarning(files: ReadonlyArray<{ name: string; openComments: number }>): string | null {
  const said = files.filter((file) => file.openComments > 0).map((file) => `${file.name} has ${file.openComments} open ${file.openComments === 1 ? "comment" : "comments"}.`);
  return said.length ? said.join(" ") : null;
}

export const setSubmitTitle = (count: number): string => `Submit ${count} ${count === 1 ? "file" : "files"} for review`;

export interface PublishQuota {
  limit: number | null;
  used: number;
}

export function publishQuotaSentence(count: number, quota?: PublishQuota | null): string {
  if (!quota || quota.limit === null || !Number.isFinite(quota.limit)) return "";
  const left = Math.max(0, quota.limit - quota.used - count);
  return `This uses ${count} of your ${quota.limit} publishes this month (${left} left).`;
}

export const unsentSentence = (unsent: number, count: number): string | null =>
  unsent === 0 ? null : unsent === count ? (count === 1 ? "It was never sent for review, so it goes straight into the published version." : "None of them was sent for review, so they go straight into the published version.") : `${unsent} of them ${unsent === 1 ? "was" : "were"} never sent for review, so ${unsent === 1 ? "it goes" : "they go"} straight into the published version.`;

export const submitReviewsWords = (reviews: number): string | null => (reviews > 1 ? `This sends ${reviews} reviews, one for each.` : null);

export function setPublishConfirm(names: readonly string[], count: number, withBoard = false, quota?: PublishQuota | null, unsent = 0, publishes = count): { title: string; description: string; confirm: string } {
  const board = count > 1 && withBoard ? "Notes publish first and the board last, so its cards never point at unpublished notes." : "";
  return {
    title: count === 1 ? "Publish 1 file?" : `Publish ${count} files together?`,
    description: [`${names.join(", ")}.`, board, unsentSentence(unsent, count), publishQuotaSentence(publishes, quota)].filter(Boolean).join(" "),
    confirm: "Publish",
  };
}
