import type { GroupLabel } from "./pr-info";

const files = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

export const groupStanding = (group: GroupLabel): string => `Part of ${group.name}, ${files(group.files)} that ${group.files === 1 ? "goes" : "go"} out together.`;

export const groupNames = (group: GroupLabel): string => `${group.name}, ${files(group.files)}`;

export const groupPublishWords = (group: GroupLabel): { title: string; description: string } => ({
  title: `Publish ${group.name}?`,
  description: `This publishes ${group.files === 1 ? "the 1 file" : `all ${group.files} files`} in the group together and makes your changes the official version everyone sees.`,
});

export const GROUP_BUSY_WORDS = {
  create: "Grouping…",
  add: "Adding…",
  remove: "Taking out…",
  ungroup: "Ungrouping…",
  stop: "Stopping…",
  rename: "Renaming…",
  resolve: "Settling…",
  abandon: "Stopping the review…",
} as const;

export type GroupBusyAction = keyof typeof GROUP_BUSY_WORDS;

export const GROUP_ACTIONS = ["create", "add", "remove", "ungroup", "stop", "rename", "resolve", "burst", "abandon"] as const;
export type GroupAction = (typeof GROUP_ACTIONS)[number];

export const groupApproveWords = (group: GroupLabel): { title: string; description: string } => ({
  title: "Approve this group?",
  description: `You're signing off on ${group.files === 1 ? "the 1 file" : `all ${group.files} files`} in ${group.name}. Your approval is recorded for the group.`,
});

export const GROUPS_TITLE = "Groups";
export const NOT_GROUPED = "Not grouped";

export const GROUP_TIP = {
  name: "Group together",
  line: "Everything added to a group is submitted as one review instead of individual reviews.",
} as const;

export const GROUP_NOT_ON_WORDS = "Group together isn't switched on for your account yet, so these files wait in Changes. You can submit or publish them one at a time from there. Write to support@specgit.com to ask for it.";
export const GROUP_PLAN_WORDS = "Group together is on the Pro and Pro Plus plans, and this repository's account isn't on one, so these files wait in Changes. You can still submit or publish them one at a time. Whoever manages the account's plan can change it on specgit.com.";

export const HOLD_PICKS = { mine: "Keep my text", theirs: "Keep GitHub's" } as const;

export const GROUP_CARD = { name: "Group name", hide: "Hide files", show: "Show files", takeOut: "Take out of this group", ungroup: "Ungroup" } as const;

export const groupFilesLabel = (name: string): string => `Files in ${name}`;

export const GROUP_FAILED_TITLE = "Couldn't change the group";

export const GROUP_FLOW_PARTIAL = "group_flow_partial";

export const flowPartialWords = (written: number, total: number): string => `${written} of ${total} files took the change from GitHub before this stopped. Try again to finish.`;

export const TRY_AGAIN_WORDS = "Try again in a moment.";

export function groupFailedWords(reason: string, code?: string | null, extra?: { written?: number; retry?: boolean }): string {
  const retry = extra?.retry ?? !code;

  const said = reason.endsWith(` ${TRY_AGAIN_WORDS}`) ? reason.slice(0, -(TRY_AGAIN_WORDS.length + 1)) : reason;

  const asTheyWere = code === GROUP_FLOW_PARTIAL || (extra?.written ?? 0) > 0 ? "" : " Your files are as they were.";
  return `${said}${asTheyWere}${retry ? ` ${TRY_AGAIN_WORDS}` : ""}`;
}

export const NOTHING_TO_GROUP = "nothing_to_group";

export const GROUP_UNREAD = "group_unread";

export const UNREAD_PICK = "specgit can't tell what changed in this group on GitHub, so nothing was changed.";

export interface GroupLeftOut {
  path: string;
  why: "same";
}

const nameList = (names: readonly string[]): string => {
  if (names.length <= 3) return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} other files`;
};

export const sameAsGitHubWords = (names: readonly string[]): string | null =>
  names.length === 0 ? null : names.length === 1 ? `${names[0]} is the same as the version in GitHub, so it wasn't added to the group.` : `${nameList(names)} are the same as the version in GitHub, so they weren't added to the group.`;

export const nothingToGroupWords = (names: readonly string[], needs: 1 | 2): string =>
  `${nameList(names)} ${names.length === 1 ? "is" : "are"} the same as the version in GitHub. ${needs === 2 ? "A group needs two files that have changes." : "There is nothing in them to add to the group."}`;

export const DELETE_CANT_JOIN = "A deleted file can't join a group. Publish the delete, or leave it unchecked.";

export const unitLabel = (entry: { path: string; group?: { name: string; files: number } }, titleOf: (path: string) => string): string =>
  entry.group ? `${entry.group.name} (${entry.group.files} ${entry.group.files === 1 ? "file" : "files"})` : titleOf(entry.path);
