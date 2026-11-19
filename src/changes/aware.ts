import { draftStateWord, groupWriters, type GroupOverview, type InFlightBranch, isGroupBranch, isViewersBranch, liveLine, liveWho, openedBy, writersLine } from "../shared/review-flow";
import type { PresenceRead } from "../review/review-api";

export interface AwareDraft {

  branch: string;
  state: "Draft" | "In review";

  names: string;

  at: string;

  others: string;

  mine: boolean;

  inNote: boolean | null;
}

export interface AwareRow {

  path: string;

  live: string | null;

  who: { names: string; many: boolean } | null;

  draft: AwareDraft | null;
}

export interface AwareState {

  live: AwareRow[];

  progress: AwareRow[];

  groups: ReadonlyMap<string, { names: string }>;

  settled: ReadonlySet<string>;

  own: ReadonlySet<string>;

  counts: { inProgress: number; live: number };
}

export interface AwareInput {
  viewer: string | null;

  paths: Readonly<Record<string, readonly InFlightBranch[]>>;
  overviews: ReadonlyMap<string, GroupOverview>;
  presence: PresenceRead | null;

  vaultPath(path: string): string;

  fileAt(vaultPath: string): { holds(blob: string): boolean } | null;
}

export function awarenessOn(paths: Readonly<Record<string, readonly InFlightBranch[]>> | undefined, presence: PresenceRead | null): boolean {
  if (presence?.kind === "docs") return true;
  return Object.values(paths ?? {}).some((entries) => entries.some((entry) => entry.writers !== undefined));
}

function pickDraft(entries: readonly InFlightBranch[], viewer: string | null): InFlightBranch | null {
  let own: InFlightBranch | null = null;
  let newest: InFlightBranch | null = null;
  for (const entry of entries) {
    if (!entry.isReviewBranch || isGroupBranch(entry.branch) || entry.changedStatus === "removed") continue;
    if (own === null && isViewersBranch(entry, viewer)) own = entry;
    if (newest === null || entry.lastCommitAt > newest.lastCommitAt) newest = entry;
  }
  return own ?? newest;
}

export const writersOf = (entry: InFlightBranch): string[] => (entry.writers && entry.writers.length > 0 ? entry.writers : [openedBy(entry) ?? entry.authorLogin ?? ""].filter((login) => login !== ""));

const namesOf = (entry: InFlightBranch, viewer: string | null): string => writersLine(writersOf(entry), viewer);

export function awareState(input: AwareInput): AwareState | null {
  if (!awarenessOn(input.paths, input.presence)) return null;
  const { viewer } = input;
  const rows = new Map<string, AwareRow>();
  const groups = new Map<string, { names: string }>();
  const inGroups = new Set<string>();
  const inProgress = new Set<string>();
  const settled = new Set<string>();
  const own = new Set<string>();

  const byBranch = new Map<string, Array<(typeof input.paths)[string][number]>>();
  for (const list of Object.values(input.paths)) for (const entry of list) if (isGroupBranch(entry.branch)) byBranch.set(entry.branch, [...(byBranch.get(entry.branch) ?? []), entry]);
  for (const [repoPath, entries] of Object.entries(input.paths)) {
    const path = input.vaultPath(repoPath);
    const file = input.fileAt(path);
    if (!file) continue;
    if (entries.some((entry) => entry.isReviewBranch && entry.docBlobSha !== undefined && file.holds(entry.docBlobSha))) settled.add(path);

    const group = entries.find((entry) => isGroupBranch(entry.branch) && input.overviews.has(entry.branch));
    if (group) {
      inGroups.add(path);
      inProgress.add(path);
      const overview = input.overviews.get(group.branch)!;
      if (!groups.has(overview.id)) groups.set(overview.id, { names: writersLine(groupWriters(byBranch.get(group.branch) ?? []), viewer) });
      continue;
    }
    const picked = pickDraft(entries, viewer);
    if (!picked) continue;
    inProgress.add(path);
    if (isViewersBranch(picked, viewer)) own.add(path);
    rows.set(path, {
      path,
      live: null,
      who: null,
      draft: { branch: picked.branch, state: draftStateWord(picked.prIsDraft !== false), names: namesOf(picked, viewer), others: writersLine(writersOf(picked).filter((login) => viewer === null || login.toLowerCase() !== viewer.toLowerCase()), null), at: picked.lastCommitAt, mine: isViewersBranch(picked, viewer), inNote: picked.docBlobSha === undefined ? null : file.holds(picked.docBlobSha) },
    });
  }
  const live: AwareRow[] = [];
  if (input.presence?.kind === "docs") {
    for (const doc of input.presence.docs) {
      const path = input.vaultPath(doc.path);
      if (!input.fileAt(path)) continue;
      const line = liveLine(doc.people, doc.agents, viewer);
      const who = liveWho(doc.people, doc.agents, viewer);
      if (line === null || who === null) continue;

      const row = rows.get(path) ?? { path, live: null, who: null, draft: null };
      rows.delete(path);
      live.push({ ...row, live: line, who });
    }
  }
  const byPath = (a: AwareRow, b: AwareRow): number => a.path.localeCompare(b.path);
  return { live: live.sort(byPath), progress: [...rows.values()].sort(byPath), groups, settled, own, counts: { inProgress: inProgress.size, live: live.length } };
}
