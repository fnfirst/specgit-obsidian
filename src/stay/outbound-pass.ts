import { gitBlobShaOfText } from "../changes/blob-sha";
import { groupWrites } from "../changes/burst";
import { agreedOf, type CacheEntry } from "../changes/cache";
import type { ChangeRow, Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { hasBom, stripBom, toLf } from "../disk/line-endings";
import type { DocumentRef } from "../mapping";
import { GROUP_NOT_ON_WORDS, GROUP_PLAN_WORDS } from "../shared/review-flow";
import type { Ended, FileFacts } from "./draft-state";
import type { WriteBudget } from "./limits";
import { changeKey, hasOwnOrAgreedDraft } from "./outbound";
import type { StayData, StayState } from "./state";
import type { StayPorts } from "./types";

const BASES_PER_PASS = 10;
const BASES_BATCHED_PER_PASS = 50;

const UNTITLED_NOTE = /(?:^|\/)Untitled(?: \d+)?\.md$/i;

export const isFreshLocalUntitled = (path: string, entry: Pick<CacheEntry, "base" | "sent"> | undefined): boolean =>
  entry !== undefined && entry.base === null && entry.sent === undefined && UNTITLED_NOTE.test(path);

export const inboundActivePaths = (looked: Looked, seen: Readonly<Record<string, string>> | null): Set<string> => {
  const active = new Set<string>();
  if (!seen) return active;
  for (const [path, sha] of looked.repo) if (seen[path] !== sha) active.add(path);
  for (const path of Object.keys(seen)) if (!looked.repo.has(path)) active.add(path);
  for (const [path, entry] of looked.files) {
    const repoSha = looked.repo.get(path);
    if (repoSha === undefined) continue;
    if ((entry.base !== null && entry.base !== repoSha) || entry.sent === repoSha) active.add(path);
  }
  return active;
};

export interface DraftBusyInput {
  awaitingAtStart: ReadonlySet<string>;
  renamed?: ReadonlySet<string>;
  heldFrom?: ReadonlySet<string>;
  awaiting: Iterable<string>;
  endedKeys: Iterable<string>;
  readyToSend?: ReadonlySet<string>;
}

export const snapshotDraftBusy = (
  looked: Looked,
  drafts: Looked["drafts"],
  awaiting: Iterable<string>,
  endedKeys: Iterable<string>,
): Set<string> => {
  const busy = new Set<string>();
  if (drafts) {
    for (const [path, draft] of drafts.byPath) {
      busy.add(path);
      if (draft.removes) for (const from of draft.removes.keys()) busy.add(from);
    }
  }
  for (const path of awaiting) busy.add(path);
  for (const path of endedKeys) busy.add(path);
  for (const [path, entry] of looked.files) if (entry.sent !== undefined) busy.add(path);
  return busy;
};

export const finalizeDraftBusy = (busy: Set<string>, extra: DraftBusyInput): Set<string> => {
  const ended = new Set(extra.endedKeys);
  if (extra.readyToSend) {
    for (const path of extra.readyToSend) {
      if (!extra.awaitingAtStart.has(path) && !ended.has(path) && !extra.renamed?.has(path) && !extra.heldFrom?.has(path)) {
        busy.delete(path);
      }
    }
  }
  if (extra.renamed) for (const path of extra.renamed) busy.add(path);
  if (extra.heldFrom) for (const path of extra.heldFrom) busy.add(path);
  for (const path of extra.awaiting) busy.add(path);
  for (const path of ended) busy.add(path);
  return busy;
};

export const filterRowsForPartial = (rows: readonly ChangeRow[], busyPaths: ReadonlySet<string>): ChangeRow[] =>
  rows.filter((row) => !busyPaths.has(row.change.path) && (row.change.from === undefined || !busyPaths.has(row.change.from)));

export const copyBusyPaths = (
  looked: Looked,
  data: Pick<StayData, "seen" | "endedOwn">,
  copyPaths: ReadonlySet<string>,
  copyLower: ReadonlySet<string>,
): Set<string> => {
  const busy = new Set<string>([
    ...copyPaths,
    ...inboundActivePaths(looked, data.seen),
    ...snapshotDraftBusy(looked, looked.drafts, [], Object.keys(data.endedOwn ?? {})),
  ]);
  for (const row of looked.rows) {
    if (copyLower.has(row.change.path.toLowerCase())) busy.add(row.change.path);
    if (row.change.from !== undefined && copyLower.has(row.change.from.toLowerCase())) busy.add(row.change.from);
    if (looked.drafts === undefined && isFreshLocalUntitled(row.change.path, looked.files.get(row.change.path))) busy.add(row.change.path);
  }
  return busy;
};

export const RETRY_WAITS_MS: readonly number[] = [5_000, 15_000, 60_000];
export const UNSURE_RETRY_MS = 30_000;

export const retryWaitFor = (waits: readonly number[], attempt: number): number =>
  waits[Math.min(Math.max(0, attempt - 1), waits.length - 1)]!;

export const stepLaterRetry = (
  counts: Map<string, { count: number; generation: number }>,
  key: string,
  generation: number,
  waits: readonly number[] = RETRY_WAITS_MS,
): number => {
  const prev = counts.get(key);
  const count = prev?.generation === generation ? prev.count + 1 : 1;
  counts.set(key, { count, generation });
  return retryWaitFor(waits, count);
};

export const keptPathsReadOnly = (looked: Looked, data: Pick<StayData, "kept" | "seen">): Set<string> => {
  const seen = data.seen ?? {};
  const kept = new Set(data.kept);
  for (const row of looked.rows) {
    if (row.change.kind === "new" && seen[row.change.path] !== undefined) kept.add(row.change.path);
  }
  return kept;
};

export const pruneStayLists = (looked: Looked, data: StayData, login: string): void => {
  const rowByKey = new Map(looked.rows.map((row) => [changeKey(row.change), row] as const));
  const keys = new Set(rowByKey.keys());
  data.baseline = (data.baseline ?? []).filter((key) => {
    const row = rowByKey.get(key);
    if (row === undefined) return false;
    if (row.change.kind === "new" || row.change.kind === "renamed") {
      return !hasOwnOrAgreedDraft(looked.files.get(row.change.path), looked.drafts?.byPath.get(row.change.path), login);
    }
    return true;
  });
  data.committed = data.committed.filter((key) => keys.has(key));
  data.held = [...new Set(data.held.filter((key) => keys.has(key)))];
  data.burst = data.burst.filter((key) => keys.has(key));
};

export const refreshGithubHolds = (
  looked: Looked,
  data: StayData,
  githubHeldBase: Map<string, string | null>,
  onRebased: (path: string, base: string) => void,
): void => {
  for (const path of [...githubHeldBase.keys()]) if (data.heldWhy?.[path] !== "github") githubHeldBase.delete(path);
  for (const [path, why] of Object.entries(data.heldWhy ?? {})) {
    if (why !== "github") continue;
    const base = looked.files.get(path)?.base ?? null;
    const heldBase = githubHeldBase.get(path);
    if (heldBase === undefined) githubHeldBase.set(path, base);
    else if (base !== null && base === looked.repo.get(path) && heldBase !== base) onRebased(path, base);
  }
};

export const endedMemoOf = (state: StayState) => ({
  get: (path: string): { sent: string; ended: Ended; base?: string | null } | undefined => state.data.endedOwn?.[path],
  has: (path: string): boolean => state.data.endedOwn?.[path] !== undefined,
  set: (path: string, one: { sent: string; ended: Ended; base?: string | null }): void => void ((state.data.endedOwn ??= {})[path] = one),
  delete: (path: string): void => void delete state.data.endedOwn?.[path],
  keys: (): string[] => Object.keys(state.data.endedOwn ?? {}),
});

export const fileFactsOf = (looked: Looked, path: string, isRemoteRoom: (path: string, sha: string) => boolean): FileFacts => {
  const entry = looked.files.get(path);
  const repoSha = looked.repo.get(path);
  const agreed = entry ? agreedOf(entry) : undefined;
  return {
    present: entry !== undefined,
    ...(entry ? { sha: entry.sha } : {}),
    ...(entry?.sent !== undefined ? { sent: entry.sent } : {}),
    ...(entry?.sentTo !== undefined ? { sentTo: entry.sentTo } : {}),
    ...(agreed !== undefined ? { agreed } : {}),
    unchanged: entry ? unchangedHere(entry) || isRemoteRoom(path, entry.sha) : false,
    deletedHere: looked.deleted.some((gone) => gone.path === path),
    published: repoSha !== undefined,
    publishedMoved: entry !== undefined && repoSha !== undefined && entry.base !== null && repoSha !== entry.base,
  };
};

export const stepBackoff = (
  map: Map<string, { strikes: number; until: number }>,
  path: string,
  now: number,
  waits: readonly number[],
): number | null => {
  let known = map.get(path);
  if (!known || (now >= known.until && known.strikes < waits.length)) {
    const strikes = known ? known.strikes : 0;
    known = { strikes: strikes + 1, until: now + waits[strikes]! };
    map.set(path, known);
  }
  return now < known.until ? known.until : null;
};

export const syncKeptPaths = (looked: Looked, data: Pick<StayData, "kept" | "seen">): boolean => {
  const seen = data.seen ?? {};
  const newPaths = new Set(looked.rows.filter((row) => row.change.kind === "new").map((row) => row.change.path));
  const kept = [...new Set([...data.kept, ...[...newPaths].filter((path) => seen[path] !== undefined)])].filter((path) => newPaths.has(path));
  const grew = kept.some((path) => !data.kept.includes(path));
  data.kept = kept;
  return grew;
};

export const keepMissingBases = async (
  looked: Looked,
  ports: Pick<StayPorts, "baseText" | "phaseOf" | "blobTexts" | "gitFile" | "recordBase">,
  basesTried: Set<string>,
  isCurrent: () => boolean,
): Promise<void> => {
  const wanted: Array<{ change: Looked["rows"][number]["change"]; doc: DocumentRef }> = [];
  for (const { change, doc } of looked.rows) {
    if (change.kind !== "edited" || change.base === null || change.repoSha !== change.base) continue;
    if (ports.baseText(change.path, change.base) !== null || ports.phaseOf(change.path) !== "local" || basesTried.has(`${change.path}|${change.base}`)) continue;
    basesTried.add(`${change.path}|${change.base}`);
    wanted.push({ change, doc });
  }
  const together = ports.blobTexts ? await ports.blobTexts(wanted.slice(0, BASES_BATCHED_PER_PASS).map(({ change, doc }) => ({ doc, sha: change.base! }))) : new Map<string, string>();
  if (!isCurrent()) return;
  let reads = 0;
  for (const [at, { change, doc }] of wanted.entries()) {
    const text = at < BASES_BATCHED_PER_PASS ? together.get(change.base!) : undefined;
    if (text !== undefined) {
      ports.recordBase(change.path, doc, toLf(text), text);
      continue;
    }
    if (reads++ >= BASES_PER_PASS || !isCurrent()) return;
    const main = await ports.gitFile(doc);
    if (main.kind === "file" && main.sha === change.base && isCurrent()) ports.recordBase(change.path, doc, toLf(main.text), main.text);
  }
};

export const backfillAgreed = async (
  looked: Looked,
  ports: Pick<StayPorts, "vault" | "agreedAs">,
  isCurrent: () => boolean,
): Promise<void> => {
  for (const [path, entry] of looked.files) {
    if (entry.sent === undefined || agreedOf(entry) !== undefined || !isCurrent()) continue;
    const text = await ports.vault.read(path);
    if (text === null || gitBlobShaOfText(text) !== entry.sha) continue;
    if (gitBlobShaOfText(toLf(text)) === entry.sent || (hasBom(text) && gitBlobShaOfText(stripBom(toLf(text))) === entry.sent)) ports.agreedAs(path, entry.sha);
  }
};

export const groupBurstFiles = async (
  looked: Looked,
  files: readonly ChangeRow[],
  ports: Pick<StayPorts, "groupsOn" | "groupsLocked" | "notify" | "createGroup" | "lookAgain">,
  budget: WriteBudget,
  state: StayState,
  isOn: () => boolean,
): Promise<{ grouped: number; left: number }> => {
  if (!ports.groupsOn()) {
    ports.notify(GROUP_NOT_ON_WORDS);
    return { grouped: 0, left: 0 };
  }
  if (ports.groupsLocked()) {
    ports.notify(GROUP_PLAN_WORDS);
    return { grouped: 0, left: 0 };
  }
  if (files.length < 2) {
    ports.notify(files.length === 1 ? "A group needs two or more files, so this one stays in the Status tab." : "Nothing is waiting to be grouped.");
    return { grouped: 0, left: files.length };
  }
  const cost = groupWrites(files.length, files.reduce((sum, row) => sum + (looked.files.get(row.change.path)?.size ?? 0), 0));
  const blocked = budget.waitFor(cost);
  if (blocked > 0) {
    ports.notify(`GitHub asked specgit to slow down. Try again in ${Math.ceil(blocked / 60_000)} min.`);
    return { grouped: 0, left: files.length };
  }
  const made = await ports.createGroup([...files]);
  if (made.writes > 0) budget.spend(made.writes);
  if (made.outcome === "limited") budget.limited(made.retryAfterMs);
  state.save();
  if (made.outcome !== "made" || !isOn()) return { grouped: 0, left: files.length };
  ports.lookAgain();
  return { grouped: files.length, left: 0 };
};
