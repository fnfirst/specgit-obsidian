import { GROUP_BRANCH_PREFIX, isGroupBranch, type GroupOverview } from "./groups";
import { openedBy, type InFlightBranch, type InFlightMap, type InFlightResponse } from "./in-flight";

export const CHANGE_GRACE_MS = 20_000;

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

  | { kind: "gone"; prNumbers: readonly number[]; paths: readonly string[] };

export const releasedChange = (id: string, ended: boolean, files: Extract<InFlightChange, { kind: "released" }>["files"], viewer: string | null, at: string, ending?: { remaining: number; total: number }): InFlightChange => ({ kind: "released", id, ended, files, viewer, at, ...(ending ? { ending } : {}) });

const branchOf = (id: string): string => `${GROUP_BRANCH_PREFIX}${id}`;

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
      const existing = groups[branch];
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
      return overview !== undefined && change.paths.every((path) => members.has(path) && (!files || hasEntry(path, (entry) => entry.branch === branch)));
    }
    case "released": {
      const branch = branchOf(change.id);
      const overview = response.groups?.[branch];
      const members = new Set(overview?.paths);
      const left = change.files.every((file) => !members.has(file.path) && (!files || (!hasEntry(file.path, (entry) => entry.branch === branch) && hasEntry(file.path, (entry) => entry.branch === file.branch))));
      return left && (!change.ended || overview === undefined);
    }
    case "renamed": {
      const overview = response.groups?.[branchOf(change.id)];
      return overview === undefined || overview.name === change.name;
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

function undoes(later: InFlightChange, earlier: InFlightChange): "wholly" | "partly" | null {
  if (earlier.kind === "released") {
    if (later.kind !== "grouped") return null;
    const put = new Set(later.paths);
    return earlier.files.length > 0 && earlier.files.every((file) => put.has(file.path)) ? "wholly" : null;
  }
  if (earlier.kind !== "grouped") return null;
  if (later.kind === "gone") return later.prNumbers.includes(earlier.prNumber) ? "wholly" : null;
  if (later.kind !== "released" || later.id !== earlier.id) return null;
  if (later.ended) return "wholly";
  const left = new Set(later.files.map((file) => file.path));
  const inside = earlier.paths.filter((path) => left.has(path)).length;
  return inside === 0 ? null : inside === earlier.paths.length ? "wholly" : "partly";
}

export function stillPending(response: InFlightResponse, pending: readonly PendingChange[], now: number): PendingChange[] {
  const young = pending.filter((one) => now - one.madeAt < CHANGE_GRACE_MS);
  const confirmed = new Set(young.filter((one) => agrees(response, one.change)));
  const settled = new Set<PendingChange>();
  for (let at = young.length - 1; at >= 0; at--) {
    const one = young[at]!;
    if (confirmed.has(one) || young.some((later, i) => i > at && settled.has(later) && undoes(later.change, one.change) === "wholly")) settled.add(one);
  }
  return young.filter((one, at) => !settled.has(one) || (confirmed.has(one) && young.some((earlier, i) => i < at && !settled.has(earlier) && undoes(one.change, earlier.change) === "partly")));
}
