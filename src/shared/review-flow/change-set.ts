import { sameLogin } from "./people";
import type { PrInfo, PrMergeableState } from "./pr-info";
import { describePublishBlock, type PublishBlock } from "./publish-policy";

export const REVIEW_STAGES = ["conflicts", "in_progress", "waiting", "auto_publish", "in_review"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

const STAGE_LABEL: Record<ReviewStage, string> = {
  conflicts: "Resolve conflicts",
  in_progress: "In progress",
  waiting: "Waiting on review",
  auto_publish: "Publishes when approved",
  in_review: "In review",
};

export const stageLabel = (stage: ReviewStage): string => STAGE_LABEL[stage];

export interface GroupRef {
  id: string;
  name: string;
  files: number;
}

export interface ChangeSetEntry {
  path: string;
  kind: "board" | "note";
  name: string;
  prNumber: number;
  prUrl: string;
  isDraft: boolean;
  authorLogin: string | null;
  stage: ReviewStage;

  block: PublishBlock | null;

  next: "submit" | "publish" | null;

  existsOnBase: boolean;

  requestedReviewers: string[];

  openComments: number;

  group?: GroupRef;

  ownerUnknown?: true;
}

export type ChangeSetAction = "submit" | "approve" | "publish";

export interface ChangeSet {
  entries: ChangeSetEntry[];

  dependencies: string[];

  stage: ReviewStage | null;
}

const nameOf = (path: string) => path.split("/").pop() ?? path;

export function reviewStage(pr: { isDraft: boolean; mergeableState?: PrMergeableState | null; autoMergeEnabled?: boolean | null }): ReviewStage {
  if (pr.mergeableState === "dirty") return "conflicts";
  if (pr.isDraft) return "in_progress";
  if (pr.mergeableState === "blocked") return pr.autoMergeEnabled ? "auto_publish" : "waiting";
  return "in_review";
}

function nextStep(isDraft: boolean, stage: ReviewStage): ChangeSetEntry["next"] {
  if (isDraft) return "submit";
  return stage === "conflicts" ? null : "publish";
}

export interface ChangeSetCardStatus {
  repoPath: string | null;

  state: "ok" | "moved" | "missing" | "draft_only";
  review: {
    pr: {
      number: number;
      url: string;
      isDraft: boolean;
      merged: boolean;
      mergeableState: PrMergeableState | null;
      authorLogin: string | null;
      autoMergeEnabled: boolean;
      requestedReviewers?: string[];
    } | null;

    openThreads: number;
  } | null;
}

export interface ChangeSetStatus {

  boardOnBase: boolean;

  cards: Record<string, ChangeSetCardStatus>;
}

export function buildChangeSet(boardPath: string, boardPr: PrInfo | null, status: ChangeSetStatus | null, boardComments = 0): ChangeSet {
  const entries: ChangeSetEntry[] = [];
  const seen = new Set<string>();
  for (const card of Object.values(status?.cards ?? {})) {
    const pr = card.review?.pr;
    if (!pr || pr.merged || !card.repoPath || seen.has(card.repoPath) || card.repoPath === boardPath) continue;
    seen.add(card.repoPath);
    const stage = reviewStage(pr);
    entries.push({
      path: card.repoPath,
      kind: "note",
      name: nameOf(card.repoPath),
      prNumber: pr.number,
      prUrl: pr.url,
      isDraft: pr.isDraft,
      authorLogin: pr.authorLogin,
      stage,
      block: null,
      next: nextStep(pr.isDraft, stage),
      existsOnBase: card.state !== "draft_only",
      requestedReviewers: pr.requestedReviewers ?? [],
      openComments: card.review?.openThreads ?? 0,
    });
  }
  if (boardPr && boardPr.state !== "merged" && boardPr.state !== "closed") {
    const stage = reviewStage(boardPr);
    entries.unshift({
      path: boardPath,
      kind: "board",
      name: nameOf(boardPath),
      prNumber: boardPr.number,
      prUrl: boardPr.url,
      isDraft: boardPr.isDraft,
      authorLogin: boardPr.authorLogin ?? null,
      stage,
      block: describePublishBlock(boardPr.mergeableState, boardPr.reviewPolicy, boardPr.autoMergeEnabled),
      next: nextStep(boardPr.isDraft, stage),
      existsOnBase: status?.boardOnBase ?? true,
      requestedReviewers: boardPr.requestedReviewers ?? [],
      openComments: boardComments,
    });
  }
  const dependencies = Object.values(status?.cards ?? {})
    .filter((c) => c.state === "draft_only" && c.repoPath)
    .map((c) => c.repoPath!);
  const stage = REVIEW_STAGES.find((s) => entries.some((e) => e.stage === s)) ?? null;
  return { entries, dependencies, stage };
}

export type NextAction = { kind: ChangeSetAction; targets: readonly ChangeSetEntry[] } | { kind: "none"; targets: readonly ChangeSetEntry[] };

export function waitsOnViewer(e: { stage: ReviewStage; authorLogin: string | null; block: PublishBlock | null }, viewerLogin: string): boolean {
  if (e.stage !== "waiting" && e.stage !== "auto_publish") return false;
  if (e.authorLogin === null || sameLogin(e.authorLogin, viewerLogin)) return false;
  return e.block === null || e.block.kind === "reviews" || e.block.kind === "changes_requested";
}

export const canTakeBack = (authorLogin: string | null | undefined, viewerLogin: string) => sameLogin(authorLogin, viewerLogin);

export const canMoveBackToDraft = (entry: Pick<ChangeSetEntry, "isDraft" | "authorLogin" | "group">, viewerLogin: string): boolean => !entry.isDraft && (entry.group !== undefined || canTakeBack(entry.authorLogin, viewerLogin));

export function nextAction(entries: readonly ChangeSetEntry[], viewerLogin: string): NextAction {
  const drafts = entries.filter((e) => e.next === "submit");
  if (drafts.length) return { kind: "submit", targets: drafts };
  const toApprove = entries.filter((e) => waitsOnViewer(e, viewerLogin));
  if (toApprove.length) return { kind: "approve", targets: toApprove };
  const ready = publishable(entries);
  return ready.length ? { kind: "publish", targets: ready } : { kind: "none", targets: [] };
}

export function publishable(entries: readonly ChangeSetEntry[]): ChangeSetEntry[] {
  return entries.filter((e) => e.next === "publish");
}

export type ReviewSectionId = "conflicts" | "draft" | "review" | "published";

const SECTION_OF: Record<ReviewStage, Exclude<ReviewSectionId, "published">> = {
  conflicts: "conflicts",
  in_progress: "draft",
  waiting: "review",
  auto_publish: "review",
  in_review: "review",
};

export interface ReviewListRow {
  entry: ChangeSetEntry;

  published: boolean;
}

export function reviewSections(set: ChangeSet, published: readonly ChangeSetEntry[]): { section: ReviewSectionId; rows: ReviewListRow[] }[] {
  const open = new Set(set.entries.map((e) => e.path));
  const boardFirst = (rows: ReviewListRow[]) => [...rows.filter((r) => r.entry.kind === "board"), ...rows.filter((r) => r.entry.kind === "note")];
  const order: ReviewSectionId[] = ["conflicts", "draft", "review", "published"];
  return order
    .map((section) => ({
      section,
      rows: boardFirst(
        section === "published"
          ? published.filter((e) => !open.has(e.path)).map((entry) => ({ entry, published: true }))
          : set.entries.filter((e) => SECTION_OF[e.stage] === section).map((entry) => ({ entry, published: false })),
      ),
    }))
    .filter((s) => s.rows.length > 0);
}

export function changeSetScope(set: ChangeSet): string | null {
  const notes = set.entries.filter((e) => e.kind === "note").length;
  const board = set.entries.some((e) => e.kind === "board");
  const counted = `${notes} ${notes === 1 ? "note" : "notes"}`;
  if (board) return notes ? `Board + ${counted}` : "Board";
  return notes ? counted : null;
}

export function changeSetCounts(set: ChangeSet): string {
  return countStages(set.entries.map((e) => e.stage));
}

export function countStages(stages: readonly ReviewStage[]): string {
  return REVIEW_STAGES.map((s) => [s, stages.filter((stage) => stage === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${STAGE_LABEL[s].toLowerCase()}`)
    .join(" · ");
}
