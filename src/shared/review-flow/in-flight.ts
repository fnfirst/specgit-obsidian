import type { PublishQuota } from "./lifecycle-copy";
import { type GroupOverview, isGroupBranch } from "./groups";
import { sameLogin } from "./people";
import { isSaveBranchFor, type SavesTo } from "./review-branch-names";

export const IN_FLIGHT_ANSWER_SHAPE = 4;

export type InFlightActivity = "fresh" | "idle" | "stale";

export interface InFlightBranch {
  branch: string;
  isReviewBranch: boolean;
  authorLogin: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  lastCommitAt: string;
  activity: InFlightActivity;
  changedStatus: string;
  renamedFrom?: string;
  docBlobSha?: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
  prIsDraft?: boolean;
  prAuthorLogin?: string | null;
  ownerLogin?: string;
  writers?: string[];
  boardNotes?: string[];
  namedForPath?: boolean;
}

export type InFlightMap = Record<string, InFlightBranch[]>;

export interface InFlightResponse {
  base: string;
  paths: InFlightMap;
  pathsKnown?: false;
  groups?: Record<string, GroupOverview>;
  groupsLocked?: true;
  saves?: SavesTo;
  canPush?: boolean;
  publishQuota?: PublishQuota;
  unscanned?: number;
  stale?: boolean;
}

export const openedBy = (entry: Pick<InFlightBranch, "prAuthorLogin" | "prNumber" | "authorLogin" | "ownerLogin">): string | null => {
  if (entry.ownerLogin != null && entry.ownerLogin !== "") return entry.ownerLogin;
  if (entry.prAuthorLogin != null && entry.prAuthorLogin !== "") return entry.prAuthorLogin;
  return entry.prNumber === undefined && entry.authorLogin != null && entry.authorLogin !== "" ? entry.authorLogin : null;
};

export const isViewersBranch = (entry: Pick<InFlightBranch, "prAuthorLogin" | "prNumber" | "authorLogin" | "ownerLogin">, viewerLogin: string | null): boolean => {
  const by = openedBy(entry);
  return sameLogin(by, viewerLogin);
};

export interface FileReviewPick {
  group: { entry: InFlightBranch; overview: GroupOverview } | null;
  own: InFlightBranch | null;
  branch: string | null;
}

export function pickFileReview(entries: readonly InFlightBranch[] | undefined, viewerLogin: string | null, groups: ReadonlyMap<string, GroupOverview>, saves?: SavesTo): FileReviewPick {
  let group: FileReviewPick["group"] = null;
  let own: InFlightBranch | null = null;
  let holder: InFlightBranch | null = null;
  for (const entry of entries ?? []) {
    if (isGroupBranch(entry.branch)) {
      const overview = groups.get(entry.branch);
      if (overview && group === null) group = { entry, overview };
      continue;
    }
    if (!entry.isReviewBranch) continue;
    if (own === null && isViewersBranch(entry, viewerLogin)) own = entry;
    if (isSaveBranchFor(entry.branch, viewerLogin, saves) && (holder === null || entry.lastCommitAt > holder.lastCommitAt)) holder = entry;
  }
  return { group, own, branch: group ? (holder?.branch ?? group.entry.branch) : (own?.branch ?? null) };
}

export function ownReviewOf(entries: readonly InFlightBranch[] | undefined, path: string, login: string, saves?: SavesTo): InFlightBranch | null {
  let holder: InFlightBranch | null = null;
  let written: InFlightBranch | null = null;
  for (const entry of entries ?? []) {
    if (!entry.isReviewBranch || isGroupBranch(entry.branch) || entry.namedForPath === false) continue;
    if (isSaveBranchFor(entry.branch, login, saves)) {
      if (holder === null || entry.lastCommitAt > holder.lastCommitAt) holder = entry;
    } else if (written === null && isViewersBranch(entry, login)) written = entry;
  }
  return holder ?? written;
}

export interface DraftWorkItem {
  path: string;
  entry: InFlightBranch;
  isViewer: boolean;
}

export function compareDraftWorkItems(a: DraftWorkItem, b: DraftWorkItem): number {
  if (a.isViewer !== b.isViewer) return a.isViewer ? -1 : 1;
  return b.entry.lastCommitAt.localeCompare(a.entry.lastCommitAt);
}

export function draftWorkItems(map: InFlightMap, viewerLogin: string | null, browsedBranch: string): DraftWorkItem[] {
  const out: DraftWorkItem[] = [];
  for (const [path, entries] of Object.entries(map)) {
    for (const entry of entries) {
      if (!entry.isReviewBranch) continue;
      if (entry.branch === browsedBranch) continue;
      if (entry.changedStatus === "removed") continue;
      out.push({
        path,
        entry,
        isViewer: isViewersBranch(entry, viewerLogin),
      });
    }
  }
  return out.sort(compareDraftWorkItems);
}
