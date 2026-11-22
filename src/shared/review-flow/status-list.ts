import { REVIEW_STAGES, reviewStage, waitsOnViewer, type ChangeSetEntry, type ReviewStage } from "./change-set";
import { describePublishBlock } from "./publish-policy";
import type { PrMergeableState, PrReviewDecision } from "./pr-info";
import { classifyOutside, type GroupOverview } from "./groups";
import { draftWorkItems, type InFlightResponse, openedBy } from "./in-flight";
import { sameLogin } from "./people";
import { endingWaitsForPick, endingWords } from "./ending";
import { HOLD_PICKS } from "./group-words";
import { entryReviewState, type ReviewState } from "./review-state";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function heldWords(
  group: Pick<GroupOverview, "hold" | "mergeableState"> & { holdUnread?: boolean; holdOthers?: number; conflictPaths?: readonly string[]; ending?: GroupOverview["ending"]; holdPaths?: readonly string[]; paths?: readonly string[] },
): string | null {
  if (group.ending && !endingWaitsForPick(group)) return endingWords(group.ending);
  if (group.hold === "overlap") return "Changed on GitHub and here. Pick which to keep.";
  if (group.hold === "outside") {
    const named = group.holdPaths ?? [];
    const members = named.filter((path) => group.paths?.includes(path)).length;
    const about = classifyOutside({ unread: group.holdUnread, members, others: named.length - members + (group.holdOthers ?? 0) });
    if (about.kind === "unread") return `specgit can't tell what changed in this group on GitHub, so it can't bring it into your files. ${HOLD_PICKS.mine} leaves your files as they are.`;
    const gone = about.kind === "others" ? "" : about.members === 1 ? "A file in this group was deleted or renamed on GitHub." : "Files in this group were deleted or renamed on GitHub.";
    const added = about.kind === "members" ? "" : about.kind === "others" ? "A file outside the group changed on GitHub." : about.others === 1 ? "A file outside the group changed there too." : "Files outside the group changed there too.";
    return `${[gone, added].filter(Boolean).join(" ")} ${HOLD_PICKS.mine} leaves that change out of this group. It stays in the pull request's history on GitHub.`;
  }
  if (group.hold === "behind") {
    const named = group.holdPaths ?? [];
    if (named.length === 0) return "The published version of a file here changed. Catch it up to publish.";
    const names = named.slice(0, 2).map((p) => p.split("/").pop() ?? p);
    const files = named.length === 1 ? names[0]! : named.length === 2 ? `${names[0]} and ${names[1]}` : `${names.join(", ")}, and ${named.length - 2} more`;
    return `The published version of ${files} changed. Catch ${named.length === 1 ? "it" : "them"} up to publish.`;
  }
  if (group.mergeableState !== "dirty") return null;
  const named = group.conflictPaths ?? [];
  if (named.length > 0) return `The published version of ${named.length === 1 ? "this file" : `${named.length} of these files`} changed too (${named.slice(0, 3).map((p) => p.split("/").pop()).join(", ")}${named.length > 3 ? ", and more" : ""}). Take ${named.length === 1 ? "it" : "them"} out, catch up with the published version, and add ${named.length === 1 ? "it" : "them"} back.`;
  return "Resolve the conflict to publish.";
}

export interface GroupHeld {
  words: string;
  conflict: boolean;
}

export function groupHeld(group: Parameters<typeof heldWords>[0]): GroupHeld | null {
  const words = heldWords(group);
  if (words === null) return null;
  return { words, conflict: !(group.ending && !endingWaitsForPick({ ending: group.ending, hold: group.hold })) };
}

export function groupEntry(group: GroupOverview): ChangeSetEntry {
  const held = groupHeld(group);
  const stage: ReviewStage = held?.conflict ? "conflicts" : reviewStage({ isDraft: group.isDraft, mergeableState: group.mergeableState });
  return {
    path: group.paths[0] ?? group.name,
    kind: "note",
    name: group.name,
    prNumber: group.prNumber,
    prUrl: group.prUrl,
    isDraft: group.isDraft,
    authorLogin: null,
    stage,
    block: null,
    next: held ? null : group.isDraft ? "submit" : "publish",
    existsOnBase: true,
    requestedReviewers: [],
    openComments: 0,
    group: { id: group.id, name: group.name, files: group.paths.length },
  };
}

export function inFlightEntries(inFlight: InFlightResponse, viewerLogin: string | null, browsedBranch: string): ChangeSetEntry[] {
  const seen = new Set<string>();
  return draftWorkItems(inFlight.paths, viewerLogin, browsedBranch).flatMap(({ path, entry }) => {
    if (seen.has(path)) return [];
    seen.add(path);
    const isDraft = entry.prIsDraft !== false;
    const stage: ReviewStage = isDraft ? "in_progress" : "in_review";
    return [
      {
        path,
        kind: "note" as const,
        name: path.split("/").pop() ?? path,
        prNumber: entry.prNumber ?? 0,
        prUrl: entry.prUrl ?? "",
        isDraft,
        authorLogin: openedBy(entry),
        ...(openedBy(entry) === null ? { ownerUnknown: true as const } : {}),
        stage,
        block: null,
        next: isDraft ? ("submit" as const) : ("publish" as const),
        existsOnBase: entry.changedStatus !== "added",
        requestedReviewers: [],
        openComments: 0,
      },
    ];
  });
}

export interface ReviewFactsLike {
  isDraft: boolean;
  state: "open" | "closed" | "merged";
  mergeableState: PrMergeableState | null;
  reviewDecision: PrReviewDecision | null;
  requestedReviewers: readonly string[];
  authorLogin: string | null;
  autoMergeEnabled?: boolean;
}

export function withReviewFacts(entry: ChangeSetEntry, facts: ReviewFactsLike): ChangeSetEntry {
  const open = facts.state === "open";
  const stage = reviewStage({ isDraft: facts.isDraft, mergeableState: facts.mergeableState, autoMergeEnabled: facts.autoMergeEnabled });
  const policy = { reviewDecision: facts.reviewDecision, approvals: 0, requiredApprovals: null, requiresCodeOwnerReview: false };
  return {
    ...entry,
    isDraft: facts.isDraft,
    stage,
    block: open ? describePublishBlock(facts.mergeableState, policy, facts.autoMergeEnabled) : null,
    next: facts.isDraft ? "submit" : stage === "conflicts" ? null : "publish",
    requestedReviewers: [...facts.requestedReviewers],
    authorLogin: entry.authorLogin ?? facts.authorLogin,
  };
}

export interface GroupFile {
  path: string;
  entry: ChangeSetEntry | null;
}

export interface StatusGroup {
  overview: GroupOverview;
  entry: ChangeSetEntry;
  files: GroupFile[];
  held: GroupHeld | null;
}

export interface StatusUnits {
  groups: StatusGroup[];
  loose: ChangeSetEntry[];
}

export function statusUnits(entries: readonly ChangeSetEntry[], groups: Record<string, GroupOverview> | undefined): StatusUnits {
  const overviews = Object.values(groups ?? {}).filter((group) => group.paths.length > 0);
  const grouped = new Set(overviews.flatMap((group) => group.paths));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return {
    groups: overviews.map((overview) => ({
      overview,
      entry: groupEntry(overview),
      held: groupHeld(overview),
      files: overview.paths.map((path) => ({ path, entry: byPath.get(path) ?? null })),
    })),
    loose: entries.filter((entry) => !grouped.has(entry.path)),
  };
}

export function selectableUnits(model: StatusUnits): ChangeSetEntry[] {
  return [...model.groups.filter((group) => !group.held).map((group) => group.entry), ...model.loose];
}

export const unitKey = (entry: ChangeSetEntry): string => (entry.group ? `g:${entry.group.id}` : entry.path);

export function unitsWords(entries: readonly ChangeSetEntry[]): string {
  const groups = entries.filter((entry) => entry.group).length;
  const files = entries.length - groups;
  return [groups && plural(groups, "group"), files && plural(files, "file")].filter(Boolean).join(" and ");
}

export const GROUP_PRO_ONLY = {
  reason: "Group together is on the Pro and Pro Plus plans.",
  upgrade: "See the plans",
  upgradePath: "/pricing",
} as const;

export type GroupList = "reading" | "failed" | "ready";

export const GROUP_READING = "Still reading what is in review. Group together is ready in a moment.";
export const GROUP_READ_FAILED = "Couldn't read what is in review. Select Group together to try again.";

export type GroupPlan = { kind: "create" | "add"; label: string } | { kind: null; label: string; reason: string; upgrade?: true; retry?: true };

export type Noun = "document" | "note";

export function groupPlan(
  selected: readonly ChangeSetEntry[],
  { entitled = true, list = "ready", cannotJoin = () => null, noun = "document" }: { entitled?: boolean; list?: GroupList; cannotJoin?: (entry: ChangeSetEntry) => string | null; noun?: Noun } = {},
): GroupPlan {
  const groups = selected.filter((entry) => entry.group);
  const loose = selected.filter((entry) => !entry.group);
  const label = "Group together";
  const none = (reason: string): GroupPlan => ({ kind: null, label, reason });
  if (list === "reading") return none(GROUP_READING);
  if (list === "failed") return { kind: null, label, reason: GROUP_READ_FAILED, retry: true };
  if (!entitled) return { kind: null, label, reason: GROUP_PRO_ONLY.reason, upgrade: true };
  const barred = loose.map(cannotJoin).find((reason) => reason !== null);
  if (barred) return none(barred);
  if (groups.length > 1) return none(`Groups can't be joined. Check one group and the ${noun}s to add.`);
  if (loose.some((entry) => !entry.isDraft)) return none(`${noun === "note" ? "Notes" : "Documents"} in review can't join a group. Move them back to draft first.`);
  if (groups.length === 0 && loose.length >= 2) {
    return { kind: "create", label };
  }
  if (groups.length === 1 && loose.length >= 1) {
    const target = groups[0]!.group!;
    return { kind: "add", label: `Add ${loose.length} to ${target.name}` };
  }
  if (groups.length === 1) return none(`Check ${noun}s to add to ${groups[0]!.group!.name}.`);
  return none(`Check two or more ${noun}s first.`);
}

export const isSomeoneElses = (entry: Pick<ChangeSetEntry, "authorLogin" | "ownerUnknown">, viewerLogin: string | null, isGroup = false): boolean =>
  !isGroup && (entry.ownerUnknown === true || (entry.authorLogin !== null && !sameLogin(entry.authorLogin, viewerLogin)));

export const byAuthor = (entry: Pick<ChangeSetEntry, "authorLogin" | "group" | "ownerUnknown">, viewerLogin: string | null): string | null => (entry.authorLogin !== null && isSomeoneElses(entry, viewerLogin, entry.group !== undefined) ? `by ${entry.authorLogin}` : null);

export const groupLine = (files: number): string => `${plural(files, "file")}, one review`;

export const fileTag = (entry: ChangeSetEntry | null): string => (entry ? (entry.existsOnBase ? "Edited" : "New") : "");

export const takeOutWords = (name: string): string => `Take ${name} out of this group`;

export const ungroupedWords = (name: string): string => `Ungrouped ${name}. Its files are back on their own, and nothing was lost.`;

export interface KeptBranch {
  branch: string;
  url: string;
  paths: readonly string[];
}

export const keptWords = (done: string, kept: KeptBranch): string => {
  const files = kept.paths.map((path) => path.split("/").pop() ?? path).join(", ");
  return kept.paths.length
    ? `${done}, but a change made on GitHub to ${files} couldn't be added to the file. It is kept on GitHub here: ${kept.url}`
    : `${done}, but GitHub did not show whether the group had just been changed there. What it held is kept on GitHub here: ${kept.url}`;
};
export const addedWords = (files: number, name: string): string => `Added ${plural(files, "file")} to ${name}.`;
export const newGroupWords = "Name your group. It's selected.";

export function newGroupName(model: Pick<StatusUnits, "groups">): string {
  const taken = new Set(model.groups.map((group) => group.overview.name));
  let n = model.groups.length + 1;
  while (taken.has(`Group ${n}`)) n += 1;
  return `Group ${n}`;
}

export function listState(units: readonly ChangeSetEntry[], viewerLogin: string): ReviewState | null {
  const pick = units.find((entry) => entry.stage === "conflicts") ?? units.find((entry) => waitsOnViewer(entry, viewerLogin)) ?? [...units].sort(byStage)[0];
  return pick ? entryReviewState(pick, viewerLogin) : null;
}

const byStage = (a: ChangeSetEntry, b: ChangeSetEntry) => REVIEW_STAGES.indexOf(a.stage) - REVIEW_STAGES.indexOf(b.stage);
