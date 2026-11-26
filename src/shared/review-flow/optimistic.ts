import { GROUP_BRANCH_PREFIX, isGroupBranch, type GroupOverview } from "./groups";
import { openedBy, type InFlightBranch, type InFlightMap, type InFlightResponse } from "./in-flight";

export const CHANGE_GRACE_MS = 45_000;

export type InFlightChange =
  | { kind: "grouped"; id: string; name: string; prNumber: number; prUrl: string; paths: readonly string[]; viewer: string | null; at: string }
  | {
      kind: "released";
      id: string;
      ended: boolean;
      files: ReadonlyArray<{ path: string; branch: string; prNumber: number; prUrl: string; isDraft: boolean }>;
      ending?: { remaining: number; total: number };
      viewer: string | null;
      at: string;
    }
  | { kind: "renamed"; id: string; name: string }
  | { kind: "draft"; paths: readonly string[]; groupIds: readonly string[]; isDraft: boolean }
  | { kind: "gone"; prNumbers: readonly number[]; paths: readonly string[]; groupIds?: readonly string[] };

export const releasedChange = (id: string, ended: boolean, files: Extract<InFlightChange, { kind: "released" }>["files"], viewer: string | null, at: string, ending?: { remaining: number; total: number }): InFlightChange => ({ kind: "released", id, ended, files, viewer, at, ...(ending ? { ending } : {}) });

const branchOf = (id: string): string => `${GROUP_BRANCH_PREFIX}${id}`;

const groupInPaths = (response: InFlightResponse, branch: string): boolean => Object.values(response.paths).some((entries) => entries.some((entry) => entry.branch === branch));

const isReview = (entry: InFlightBranch): boolean => entry.isReviewBranch;

function withPaths(response: InFlightResponse, paths: InFlightMap, groups: Record<string, GroupOverview> | undefined): InFlightResponse {
  return { ...response, paths, ...(groups ? { groups } : {}) };
}

function withoutEntries(paths: InFlightMap, drop: (entry: InFlightBranch, path: string) => boolean): InFlightMap {
  return Object.fromEntries(Object.entries(paths).flatMap(([path, entries]) => {
    const kept = entries.filter((entry) => !drop(entry, path));
    return kept.length > 0 ? [[path, kept] as const] : [];
  }));
}

const ownerOf = (old: InFlightBranch | undefined, viewer: string | null, branch: string): string | null => (old === undefined ? viewer : old.branch === branch ? (old.ownerLogin ?? null) : openedBy(old));

export function applyChange(response: InFlightResponse, change: InFlightChange): InFlightResponse {
  const groups = response.groups ? { ...response.groups } : undefined;
  switch (change.kind) {
    case "grouped": {
      if (!groups) return response;
      const branch = branchOf(change.id);
      const moving = new Set(change.paths);
      for (const [otherBranch, other] of Object.entries(groups)) {
        if (otherBranch === branch) continue;
        const kept = other.paths.filter((path) => !moving.has(path));
        if (kept.length === other.paths.length) continue;
        if (kept.length === 0) delete groups[otherBranch];
        else groups[otherBranch] = { ...other, paths: kept };
      }
      const existing = groups[branch]?.prNumber === change.prNumber ? groups[branch] : undefined;
      const members = [...new Set([...(existing?.paths ?? []), ...change.paths])];
      const overview: GroupOverview = { isDraft: true, mergeableState: null, hold: null, holdPaths: [], ...existing, id: change.id, name: change.name, prNumber: change.prNumber, prUrl: change.prUrl, paths: members };
      groups[branch] = overview;
      const paths: InFlightMap = { ...response.paths };
      for (const path of change.paths) {
        const prior = paths[path] ?? [];
        const old = prior.find(isReview);
        const owner = ownerOf(old, change.viewer, branch);
        const entry: InFlightBranch = {
          branch,
          isReviewBranch: true,
          authorLogin: old?.authorLogin ?? change.viewer,
          ...(change.viewer ? { prAuthorLogin: change.viewer } : {}),
          ...(owner ? { ownerLogin: owner } : {}),
          authorName: old?.authorName ?? change.viewer,
          authorAvatarUrl: old?.authorAvatarUrl ?? null,
          lastCommitAt: change.at,
          activity: "fresh",
          changedStatus: old?.changedStatus ?? "modified",
          ...(old?.docBlobSha ? { docBlobSha: old.docBlobSha } : {}),
          prNumber: change.prNumber,
          prTitle: change.name,
          prUrl: change.prUrl,
          prIsDraft: overview.isDraft,
        };
        paths[path] = [entry, ...prior.filter((one) => !isReview(one))];
      }
      return withPaths(response, paths, groups);
    }
    case "released": {
      const branch = branchOf(change.id);
      const returned = new Map(change.files.map((file) => [file.path, file]));
      const overview = groups?.[branch];
      if (groups && overview) {
        if (change.ended) delete groups[branch];
        else groups[branch] = { ...overview, paths: overview.paths.filter((path) => !returned.has(path)), ...(change.ending ? { ending: change.ending } : {}) };
      }
      const paths: InFlightMap = {};
      for (const [path, entries] of Object.entries(response.paths)) {
        const inGroup = entries.find((entry) => entry.branch === branch);
        const file = returned.get(path);
        const leaving = inGroup !== undefined && (change.ended || file !== undefined);
        if (!leaving) {
          paths[path] = entries;
          continue;
        }
        const rest = entries.filter((entry) => entry.branch !== branch);
        const { prAuthorLogin: _groupsOpener, ...held } = inGroup ?? ({} as InFlightBranch);
        const own: InFlightBranch[] = file ? [{ ...held, branch: file.branch, prNumber: file.prNumber, prUrl: file.prUrl, prIsDraft: file.isDraft }] : [];
        if (own.length + rest.length > 0) paths[path] = [...own, ...rest];
      }
      for (const file of change.files) {
        if (paths[file.path]) continue;
        paths[file.path] = [
          {
            branch: file.branch,
            isReviewBranch: true,
            authorLogin: change.viewer,
            authorName: change.viewer,
            authorAvatarUrl: null,
            lastCommitAt: change.at,
            activity: "fresh",
            changedStatus: "modified",
            prNumber: file.prNumber,
            prUrl: file.prUrl,
            prIsDraft: file.isDraft,
          },
        ];
      }
      return withPaths(response, paths, groups);
    }
    case "renamed": {
      const overview = groups?.[branchOf(change.id)];
      if (!groups || !overview) return response;
      groups[branchOf(change.id)] = { ...overview, name: change.name };
      return { ...response, groups };
    }
    case "draft": {
      const branches = new Set(change.groupIds.map(branchOf));
      const files = new Set(change.paths);
      const paths: InFlightMap = Object.fromEntries(
        Object.entries(response.paths).map(([path, entries]) => [path, entries.map((entry) => (isReview(entry) && (branches.has(entry.branch) || (files.has(path) && !isGroupBranch(entry.branch))) ? { ...entry, prIsDraft: change.isDraft } : entry))] as const),
      );
      if (groups) for (const branch of branches) if (groups[branch]) groups[branch] = { ...groups[branch], isDraft: change.isDraft };
      return withPaths(response, paths, groups);
    }
    case "gone": {
      const numbers = new Set(change.prNumbers);
      const files = new Set(change.paths);
      if (groups) for (const [branch, overview] of Object.entries(groups)) if (numbers.has(overview.prNumber)) delete groups[branch];
      return withPaths(response, withoutEntries(response.paths, (entry, path) => isReview(entry) && (entry.prNumber ? numbers.has(entry.prNumber) : files.has(path) && !isGroupBranch(entry.branch))), groups);
    }
    default: {
      const _exhaustive: never = change;
      return _exhaustive;
    }
  }
}

export function agrees(response: InFlightResponse, change: InFlightChange): boolean {
  const files = response.pathsKnown !== false;
  const hasEntry = (path: string, test: (entry: InFlightBranch) => boolean) => (response.paths[path] ?? []).some(test);
  switch (change.kind) {
    case "grouped": {
      const branch = branchOf(change.id);
      const overview = response.groups?.[branch];
      const members = new Set(overview?.paths);
      return overview !== undefined && overview.prNumber === change.prNumber && change.paths.every((path) => members.has(path) && (!files || hasEntry(path, (entry) => entry.branch === branch)));
    }
    case "released": {
      return releasedSettled(response, change, []);
    }
    case "renamed": {
      const branch = branchOf(change.id);
      const overview = response.groups?.[branch];
      return overview === undefined ? !groupInPaths(response, branch) : overview.name === change.name;
    }
    case "draft": {
      const groupsDone = change.groupIds.every((id) => {
        const overview = response.groups?.[branchOf(id)];
        return overview === undefined || overview.isDraft === change.isDraft;
      });
      const filesDone = change.paths.every((path) => (response.paths[path] ?? []).filter((entry) => isReview(entry) && !isGroupBranch(entry.branch)).every((entry) => entry.prIsDraft === change.isDraft));
      return groupsDone && filesDone;
    }
    case "gone": {
      const numbers = new Set(change.prNumbers);
      const stands = Object.values(response.groups ?? {}).some((overview) => numbers.has(overview.prNumber));
      const filePaths = new Set(change.paths);
      const listed = Object.entries(response.paths).some(([path, entries]) => entries.some((entry) => isReview(entry) && (entry.prNumber ? numbers.has(entry.prNumber) : filePaths.has(path) && !isGroupBranch(entry.branch))));
      return !stands && !listed;
    }
    default: {
      const _exhaustive: never = change;
      return _exhaustive;
    }
  }
}

export interface PendingChange {
  change: InFlightChange;
  madeAt: number;
}

export function applyPending(response: InFlightResponse, pending: readonly PendingChange[]): InFlightResponse {
  return pending.reduce((shown, { change }) => applyChange(shown, change), response);
}

const goneMatches = (file: { path: string; prNumber: number }, numbers: ReadonlySet<number>, paths: ReadonlySet<string>): boolean => (file.prNumber ? numbers.has(file.prNumber) : paths.has(file.path));

function undoes(later: InFlightChange, earlier: InFlightChange): "wholly" | "partly" | null {
  if (earlier.kind === "released") {
    if (later.kind === "grouped") {
      const put = new Set(later.paths);
      const moved = earlier.files.filter((file) => put.has(file.path)).length;
      if (moved > 0) return moved === earlier.files.length ? "wholly" : "partly";
      return earlier.ended && later.id === earlier.id ? (earlier.files.length === 0 ? "wholly" : "partly") : null;
    }
    if (later.kind === "gone") {
      const numbers = new Set(later.prNumbers);
      const paths = new Set(later.paths);
      const dropped = earlier.files.filter((file) => goneMatches(file, numbers, paths)).length;
      return dropped === 0 ? null : dropped === earlier.files.length ? "wholly" : "partly";
    }
    if (later.kind === "draft") {
      return earlier.files.some((file) => later.paths.includes(file.path) && later.isDraft !== file.isDraft) ? "partly" : null;
    }
    return null;
  }
  if (earlier.kind === "renamed") {
    if (later.kind === "released" && later.id === earlier.id && later.ended) return "wholly";
    if (later.kind === "gone" && later.groupIds?.includes(earlier.id)) return "wholly";
    if (later.kind === "renamed" && later.id === earlier.id && later.name !== earlier.name) return "wholly";
    if (later.kind === "grouped" && later.id === earlier.id && later.name !== earlier.name) return "wholly";
    return null;
  }
  if (earlier.kind === "draft") {
    const named = earlier.paths.length + earlier.groupIds.length;
    if (later.kind === "draft" && later.isDraft !== earlier.isDraft) {
      const paths = new Set(later.paths);
      const groupIds = new Set(later.groupIds);
      const moved = earlier.paths.filter((path) => paths.has(path)).length + earlier.groupIds.filter((id) => groupIds.has(id)).length;
      return moved === 0 ? null : moved === named ? "wholly" : "partly";
    }
    if (later.kind === "released" && later.ended) {
      const moved = earlier.groupIds.filter((id) => id === later.id).length;
      return moved === 0 ? null : moved === named ? "wholly" : "partly";
    }
    if (later.kind === "gone" && later.groupIds?.length) {
      const ids = new Set(later.groupIds);
      const moved = earlier.groupIds.filter((id) => ids.has(id)).length;
      return moved === 0 ? null : moved === named ? "wholly" : "partly";
    }
    if (later.kind === "grouped") {
      const put = new Set(later.paths);
      const moved = earlier.paths.filter((path) => put.has(path)).length;
      return moved === 0 ? null : moved === named ? "wholly" : "partly";
    }
    return null;
  }
  if (earlier.kind !== "grouped") return null;
  if (later.kind === "grouped") {
    if (later.id === earlier.id) return later.prNumber !== earlier.prNumber ? "wholly" : null;
    const moved = new Set(later.paths);
    const inside = earlier.paths.filter((path) => moved.has(path)).length;
    return inside === 0 ? null : inside === earlier.paths.length ? "wholly" : "partly";
  }
  if (later.kind === "renamed") return later.id === earlier.id && later.name !== earlier.name ? "partly" : null;
  if (later.kind === "draft") return later.groupIds.includes(earlier.id) ? "partly" : null;
  if (later.kind === "gone") return later.prNumbers.includes(earlier.prNumber) ? "wholly" : null;
  if (later.kind !== "released" || later.id !== earlier.id) return null;
  if (later.ended) return "wholly";
  const left = new Set(later.files.map((file) => file.path));
  const inside = earlier.paths.filter((path) => left.has(path)).length;
  return inside === 0 ? null : inside === earlier.paths.length ? "wholly" : "partly";
}

function prOfGroupAt(all: readonly PendingChange[], at: number, id: string): number | null {
  const goneBefore = new Set<number>();
  for (let i = at - 1; i >= 0; i--) {
    const change = all[i]!.change;
    if (change.kind === "gone") for (const n of change.prNumbers) goneBefore.add(n);
    else if (change.kind === "grouped" && change.id === id) return goneBefore.has(change.prNumber) ? null : change.prNumber;
    else if (change.kind === "released" && change.id === id && change.ended) return null;
  }
  for (let i = at + 1; i < all.length; i++) {
    const change = all[i]!.change;
    if (change.kind === "grouped" && change.id === id) return change.prNumber;
    if (change.kind === "released" && change.id === id && change.ended) return null;
    if (change.kind === "gone") return null;
  }
  return null;
}

function endedGroups(all: readonly PendingChange[], at: number, ids: readonly string[], later: readonly InFlightChange[]): Set<string> {
  const ended = new Set<string>();
  const goneNumbers = new Set<number>();
  for (const one of later) {
    if (one.kind === "released" && one.ended) ended.add(one.id);
    else if (one.kind === "gone") {
      for (const n of one.prNumbers) goneNumbers.add(n);
      if (one.groupIds) for (const id of one.groupIds) ended.add(id);
    }
  }
  if (goneNumbers.size > 0) {
    for (const id of ids) {
      if (ended.has(id)) continue;
      const pr = prOfGroupAt(all, at, id);
      if (pr !== null && goneNumbers.has(pr)) ended.add(id);
    }
  }
  return ended;
}

function draftOutcome(
  response: InFlightResponse,
  change: Extract<InFlightChange, { kind: "draft" }>,
  laterSettled: readonly InFlightChange[],
  endedGroupIds: ReadonlySet<string>,
): { settled: boolean; groupIds: readonly string[]; paths: readonly string[] } {
  const undoneGroups = new Set<string>(endedGroupIds);
  const groupedPaths = new Set<string>();
  const undonePaths = new Set<string>();
  for (const later of laterSettled) {
    if (later.kind === "draft" && later.isDraft !== change.isDraft) {
      for (const id of later.groupIds) undoneGroups.add(id);
      for (const path of later.paths) undonePaths.add(path);
    } else if (later.kind === "grouped") {
      for (const path of later.paths) {
        groupedPaths.add(path);
        undonePaths.add(path);
      }
    }
  }
  const groupsDone = change.groupIds.every((id) => {
    if (undoneGroups.has(id)) return true;
    const overview = response.groups?.[branchOf(id)];
    return overview === undefined || overview.isDraft === change.isDraft;
  });
  const filesDone = change.paths.every((path) => {
    if (undonePaths.has(path)) return true;
    return (response.paths[path] ?? []).filter((entry) => isReview(entry) && !isGroupBranch(entry.branch)).every((entry) => entry.prIsDraft === change.isDraft);
  });
  return {
    settled: groupsDone && filesDone,
    groupIds: change.groupIds.filter((id) => !endedGroupIds.has(id)),
    paths: change.paths.filter((path) => !groupedPaths.has(path)),
  };
}

function releasedSettled(response: InFlightResponse, change: Extract<InFlightChange, { kind: "released" }>, laterSettled: readonly InFlightChange[]): boolean {
  const files = response.pathsKnown !== false;
  const branch = branchOf(change.id);
  const overview = response.groups?.[branch];
  const members = new Set(overview?.paths);
  const hasEntry = (path: string, test: (entry: InFlightBranch) => boolean) => (response.paths[path] ?? []).some(test);
  const regroupedHere = new Set<string>();
  const regroupedElsewhere = new Set<string>();
  const goneNumbers = new Set<number>();
  const gonePaths = new Set<string>();
  let groupedSame = false;
  for (const later of laterSettled) {
    if (later.kind === "grouped") {
      if (later.id === change.id) groupedSame = true;
      const target = later.id === change.id ? regroupedHere : regroupedElsewhere;
      for (const path of later.paths) target.add(path);
    } else if (later.kind === "gone") {
      for (const n of later.prNumbers) goneNumbers.add(n);
      for (const path of later.paths) gonePaths.add(path);
    }
  }
  if (change.ended && overview !== undefined && !groupedSame) return false;
  return change.files.every((file) => {
    if (regroupedHere.has(file.path)) return true;
    const left = !members.has(file.path) && (!files || !hasEntry(file.path, (entry) => entry.branch === branch));
    if (!left) return false;
    if (regroupedElsewhere.has(file.path)) return true;
    if (!files || hasEntry(file.path, (entry) => entry.branch === file.branch)) return true;
    return goneMatches(file, goneNumbers, gonePaths);
  });
}

export function stillPending(response: InFlightResponse, pending: readonly PendingChange[], now: number): PendingChange[] {
  const youngEntries = pending.flatMap((one, index) => (now - one.madeAt < CHANGE_GRACE_MS ? [{ one, index }] : []));
  const young = youngEntries.map((entry) => entry.one);
  const confirmed = new Set(young.filter((one) => agrees(response, one.change)));
  const settled = new Set<PendingChange>();
  const trimmedDrafts = new Map<PendingChange, PendingChange>();
  for (let at = youngEntries.length - 1; at >= 0; at--) {
    const { one, index } = youngEntries[at]!;
    if (confirmed.has(one) && (one.change.kind !== "renamed" || response.groups?.[branchOf(one.change.id)] !== undefined)) {
      settled.add(one);
      continue;
    }
    const laterSettled = young.slice(at + 1).filter((later) => settled.has(later)).map((later) => later.change);
    if (one.change.kind === "released") {
      if (releasedSettled(response, one.change, laterSettled)) settled.add(one);
    } else if (one.change.kind === "draft") {
      const ended = endedGroups(pending, index, one.change.groupIds, laterSettled);
      const outcome = draftOutcome(response, one.change, laterSettled, ended);
      if (outcome.settled) settled.add(one);
      else if (outcome.groupIds.length < one.change.groupIds.length || outcome.paths.length < one.change.paths.length) {
        trimmedDrafts.set(one, { ...one, change: { ...one.change, groupIds: outcome.groupIds, paths: outcome.paths } });
      }
    } else if (one.change.kind === "renamed") {
      if (endedGroups(pending, index, [one.change.id], laterSettled).has(one.change.id) || laterSettled.some((later) => undoes(later, one.change) === "wholly")) settled.add(one);
    } else if (laterSettled.some((later) => undoes(later, one.change) === "wholly")) {
      settled.add(one);
    }
  }
  for (let at = young.length - 1; at >= 0; at--) {
    const one = young[at]!;
    if (one.change.kind !== "renamed" || settled.has(one) || !confirmed.has(one)) continue;
    const id = one.change.id;
    if (!young.some((earlier, i) => i < at && !settled.has(earlier) && earlier.change.kind === "grouped" && earlier.change.id === id)) settled.add(one);
  }
  const kept = new Set<PendingChange>();
  const effective = (one: PendingChange): PendingChange => trimmedDrafts.get(one) ?? one;
  for (let at = 0; at < young.length; at++) {
    const one = young[at]!;
    if (!settled.has(one) || young.some((earlier, i) => i < at && kept.has(earlier) && undoes(one.change, effective(earlier).change) !== null)) kept.add(one);
  }
  return young.filter((one) => kept.has(one)).map(effective);
}

export function draftFlagsPending(shown: InFlightResponse, pending: readonly PendingChange[]): Map<number, boolean> {
  const moved = new Map<number, boolean>();
  for (let at = 0; at < pending.length; at++) {
    const { change } = pending[at]!;
    if (change.kind !== "draft") continue;
    const ended = endedGroups(pending, at, change.groupIds, pending.slice(at + 1).map((one) => one.change));
    for (const id of change.groupIds) {
      if (ended.has(id)) continue;
      const branch = branchOf(id);
      const overview = shown.groups?.[branch];
      if (overview && overview.prNumber > 0) moved.set(overview.prNumber, change.isDraft);
      for (const entries of Object.values(shown.paths)) {
        for (const entry of entries) if (entry.branch === branch && isReview(entry) && entry.prNumber && entry.prNumber > 0) moved.set(entry.prNumber, change.isDraft);
      }
    }
    for (const path of change.paths) {
      for (const entry of shown.paths[path] ?? []) if (isReview(entry) && !isGroupBranch(entry.branch) && entry.prNumber && entry.prNumber > 0) moved.set(entry.prNumber, change.isDraft);
    }
  }
  return moved;
}
