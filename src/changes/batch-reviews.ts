import { type GroupOverview, type InFlightBranch, isGroupBranch, isSomeoneElses, openedBy as openerOf, type PrInfo, sameLogin, pickFileReview, type SavesTo } from "../shared/review-flow";
import type { ReviewStatus } from "../review/review-api";
import type { TheirReview } from "./vault-state";
import type { Draft } from "../stay/draft-state";

export const reviewAuthor = (entry: InFlightBranch): string | null => openerOf(entry);

const openedBy = (entries: readonly InFlightBranch[], login: string | null): InFlightBranch | null =>
  entries.find((entry) => entry.changedStatus !== "removed" && entry.isReviewBranch && !isGroupBranch(entry.branch) && entry.prNumber !== undefined && entry.prAuthorLogin != null && sameLogin(entry.prAuthorLogin, login)) ?? null;

const prOf = (entry: InFlightBranch): PrInfo | null =>
  entry.prNumber === undefined ? null : { number: entry.prNumber, url: entry.prUrl ?? "", state: entry.prIsDraft === false ? "open" : "draft", isDraft: entry.prIsDraft !== false, authorLogin: reviewAuthor(entry) };

export interface BatchReview {
  review: ReviewStatus | null;
  needsDetail: boolean;
}

export function reviewFromInFlight(entries: readonly InFlightBranch[] | undefined, login: string | null, groups: ReadonlyMap<string, GroupOverview>, saves?: SavesTo): BatchReview {
  const none: BatchReview = { review: null, needsDetail: false };
  if (!entries || entries.length === 0) return none;
  const { group, own, branch } = pickFileReview(entries, login, groups, saves);
  if (group) {
    const { entry, overview } = group;
    const pr: PrInfo = { number: overview.prNumber, url: overview.prUrl, state: overview.isDraft ? "draft" : "open", isDraft: overview.isDraft, mergeableState: overview.mergeableState, authorLogin: entry.authorLogin, group: { name: overview.name, files: overview.paths.length } };
    return { review: { reviewBranch: branch, pr }, needsDetail: false };
  }
  const theirs = openedBy(entries, login) ?? own;
  if (!theirs) return none;
  const pr = prOf(theirs);
  return { review: { reviewBranch: theirs.branch, pr }, needsDetail: pr !== null && !pr.isDraft };
}

export function isOwnDraft(entries: readonly InFlightBranch[] | undefined, branch: string, login: string | null, groups: ReadonlyMap<string, GroupOverview>, saves?: SavesTo): boolean {
  return pickFileReview(entries, login, groups, saves).own?.branch === branch;
}

function teammateEntry(entries: readonly InFlightBranch[], login: string): InFlightBranch | null {
  for (const entry of entries) {
    if (entry.changedStatus === "removed") continue;
    const by = reviewAuthor(entry);
    if (!entry.isReviewBranch || isGroupBranch(entry.branch) || by === null || !isSomeoneElses({ authorLogin: by }, login)) continue;
    return entry;
  }
  return null;
}

export function teammateReview(entries: readonly InFlightBranch[] | undefined, login: string | null, groups: ReadonlyMap<string, GroupOverview>, saves?: SavesTo): TheirReview | null {
  if (!entries || entries.length === 0 || login === null || login === "") return null;
  const entry = teammateEntry(entries, login);
  if (!entry) return null;
  const { group, own } = pickFileReview(entries, login, groups, saves);
  if (own || group || openedBy(entries, login)) return null;
  return { by: reviewAuthor(entry)!, branch: entry.branch, prNumber: entry.prNumber ?? null, prUrl: entry.prUrl ?? null, draft: prOf(entry)?.isDraft ?? true };
}

export function draftOf(entries: readonly InFlightBranch[] | undefined, login: string | null, groups: ReadonlyMap<string, GroupOverview>, saves?: SavesTo): Draft | null {
  if (!entries || entries.length === 0) return null;
  const { group, own, branch } = pickFileReview(entries, login, groups, saves);
  if (group) {
    const mine = branch === null || isGroupBranch(branch) ? null : entries.find((one) => one.branch === branch);
    if (!mine) return { branch: group.entry.branch, blob: group.entry.docBlobSha ?? null, by: reviewAuthor(group.entry), lastBy: group.entry.authorLogin || null, prNumber: group.overview.prNumber, inGroup: true, viaGroup: true };
    return { branch: mine.branch, blob: mine.docBlobSha ?? null, by: reviewAuthor(mine), lastBy: mine.authorLogin || null, prNumber: mine.prNumber ?? null, inGroup: true };
  }
  const entry = openedBy(entries, login) ?? own ?? (login === null || login === "" ? null : teammateEntry(entries, login));
  if (!entry) return null;
  return { branch: entry.branch, blob: entry.docBlobSha ?? null, by: reviewAuthor(entry), lastBy: entry.authorLogin || null, prNumber: entry.prNumber ?? null };
}

export function removalsByBranch(paths: Readonly<Record<string, readonly InFlightBranch[]>>, vaultPath: (path: string) => string): Map<string, Map<string, string | null>> {
  const found = new Map<string, Map<string, string | null>>();
  const add = (branch: string, from: string, to: string | null): void => {
    const removed = found.get(branch) ?? new Map<string, string | null>();
    removed.set(from, to);
    found.set(branch, removed);
  };
  for (const path in paths) {
    const entries = paths[path];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.changedStatus === "removed") add(entry.branch, vaultPath(path), null);
      else if (entry.changedStatus === "renamed" && entry.renamedFrom) add(entry.branch, vaultPath(entry.renamedFrom), vaultPath(path));
    }
  }
  return found;
}

export function teammateReviews(paths: Readonly<Record<string, readonly InFlightBranch[]>>, login: string | null, groups: ReadonlyMap<string, GroupOverview>, saves: SavesTo | undefined, vaultPath: (path: string) => string): Map<string, TheirReview> {
  const found = new Map<string, TheirReview>();
  for (const path in paths) {
    const review = teammateReview(paths[path], login, groups, saves);
    if (review) found.set(vaultPath(path), review);
  }
  return found;
}
