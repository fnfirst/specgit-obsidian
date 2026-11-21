import type { EndingProgress } from "./ending";

export const GROUP_BRANCH_PREFIX = "specgit/review/group/g";

export const isGroupBranch = (branch: string): boolean => branch.startsWith(GROUP_BRANCH_PREFIX);

export const groupIdOfBranch = (branch: string): string | null =>
  isGroupBranch(branch) && /^[0-9a-f]{12}$/.test(branch.slice(GROUP_BRANCH_PREFIX.length)) ? branch.slice(GROUP_BRANCH_PREFIX.length) : null;

export type GroupHold = "overlap" | "outside" | "behind";

export const heldKind = (hold: GroupHold | null | undefined): hold is "overlap" | "outside" => hold === "overlap" || hold === "outside";

export interface GroupOverview {
  id: string;
  name: string;
  prNumber: number;
  prUrl: string;
  isDraft: boolean;
  mergeableState: "clean" | "dirty" | "blocked" | "unknown" | null;
  hold: GroupHold | null;
  holdPaths: string[];
  holdUnread?: boolean;
  holdOthers?: number;
  paths: string[];
  conflictPaths?: string[];
  ending?: EndingProgress;
}

export type OutsideHold = { kind: "unread" } | { kind: "members"; members: number } | { kind: "others"; others: number } | { kind: "both"; members: number; others: number };

export function classifyOutside(hold: { unread?: boolean; members: number; others: number }): OutsideHold {
  if (hold.unread) return { kind: "unread" };
  if (hold.members > 0 && hold.others > 0) return { kind: "both", members: hold.members, others: hold.others };
  if (hold.members > 0) return { kind: "members", members: hold.members };
  return { kind: "others", others: Math.max(1, hold.others) };
}
