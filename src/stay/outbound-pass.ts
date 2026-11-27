import { gitBlobShaOfText } from "../changes/blob-sha";
import { groupWrites } from "../changes/burst";
import { agreedOf, type CacheEntry } from "../changes/cache";
import type { ChangeRow, Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { hasBom, stripBom, toLf, withBomAndEol } from "../disk/line-endings";
import { type DocumentRef, noteName } from "../mapping";
import { GROUP_NOT_ON_WORDS, GROUP_PLAN_WORDS } from "../shared/review-flow";
import type { Activity } from "./activity";
import { type Case, draftCase, type Draft, type Ended, type FileFacts, follows, isClean, type LeftAlone, type StayDrafts } from "./draft-state";
import { type GitObservation, sameGitMark } from "./git-watch";
import type { StayHolds } from "./holds";
import type { Pace, WriteBudget } from "./limits";
import { type BlockedNew, changeKey, hasOwnOrAgreedDraft, isEdit, type OutboundInput } from "./outbound";
import { type StayData, type StayGitMark, type StayState, TYPED_KEPT } from "./state";
import type { StayPorts } from "./types";
import { DRAFT_SAID } from "./words";

const BASES_PER_PASS = 10;
const BASES_BATCHED_PER_PASS = 50;
const RECENT_COMMITTED_MS = 60_000;
export const LIVE_HEARD_PER_PASS = 8;

export const yieldQuiet = async (ctx: {
  ports: Pick<StayPorts, "later">;
  current(): boolean;
  quietWaitMs?: () => number;
}): Promise<void> => {
  for (let spins = 0; spins < 32 && ctx.current(); spins++) {
    const waitMs = ctx.quietWaitMs?.() ?? 0;
    if (waitMs <= 0) return;
    await new Promise<void>((resolve) => void ctx.ports.later(resolve, waitMs));
  }
};

export const fallbackHeardDraft = (looked: Looked, path: string, login: string): Draft | null => {
  const known = looked.drafts?.byPath.get(path);
  if (known) return { ...known, blob: "" };
  const row = looked.rows.find((one) => one.change.path === path);
  if (!row?.review?.reviewBranch) return null;
  return { branch: row.review.reviewBranch, blob: "", by: row.review.pr?.authorLogin ?? login, prNumber: row.review.pr?.number ?? null };
};

export const UNTITLED_NOTE = /(?:^|\/)Untitled(?: \d+)?\.(?:md|canvas|base)$/i;
export const UNTITLED_CANVAS = /(?:^|\/)Untitled(?: \d+)?\.canvas$/i;
export const BLANK_CANVAS_MAX_BYTES = 32;

export const isBlankUntitledCanvasText = (text: string): boolean => {
  const trimmed = stripBom(text).trim();
  if (trimmed === "" || trimmed === "{}") return true;
  if (trimmed.length > BLANK_CANVAS_MAX_BYTES) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "nodes" && key !== "edges")) return false;
    const nodesOk = record.nodes === undefined || (Array.isArray(record.nodes) && record.nodes.length === 0);
    const edgesOk = record.edges === undefined || (Array.isArray(record.edges) && record.edges.length === 0);
    return nodesOk && edgesOk;
  } catch {
    return false;
  }
};

const BLANK_CANVAS_SHAS: ReadonlySet<string> = new Set(
  [
    "",
    "{}",
    "{}\n",
    "{}\r\n",
    '{"nodes":[],"edges":[]}',
    '{"nodes":[],"edges":[]}\n',
    '{"nodes":[],"edges":[]}\r\n',
    '{"edges":[],"nodes":[]}',
    '{"edges":[],"nodes":[]}\n',
    '{\n  "nodes": [],\n  "edges": []\n}',
    '{\n\t"nodes": [],\n\t"edges": []\n}',
  ].map(gitBlobShaOfText),
);

export const isFreshLocalUntitled = (path: string, entry: Pick<CacheEntry, "base" | "sent"> | undefined): boolean =>
  entry !== undefined && entry.base === null && entry.sent === undefined && UNTITLED_NOTE.test(path);

export const isBlankLocalUntitled = (
  path: string,
  entry: Pick<CacheEntry, "base" | "sent" | "size" | "sha"> | undefined,
): boolean => {
  if (!isFreshLocalUntitled(path, entry)) return false;
  if (entry!.size === 0) return true;
  if (!UNTITLED_CANVAS.test(path) || entry!.size > BLANK_CANVAS_MAX_BYTES) return false;
  return BLANK_CANVAS_SHAS.has(entry!.sha);
};

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

export interface PreDraftBusyInput {
  looked: Looked;
  awaiting: Iterable<string>;
  endedKeys: Iterable<string>;
  deferredRenameSources?: ReadonlySet<string>;
  committed: ReadonlySet<string>;
  login: string;
  now: number;
  inGroup: (path: string) => boolean;
  policyFor: (path: string, draft: Pick<Draft, "blob">) => StayDrafts;
  isRemoteRoom: (path: string, sha: string) => boolean;
  keepPaths?: ReadonlySet<string>;
}

export const computeBusyBeforeDraftRun = (input: PreDraftBusyInput): Set<string> => {
  const { looked } = input;
  const drafts = looked.drafts;
  const awaitingSet = new Set(input.awaiting);
  const endedSet = new Set(input.endedKeys);
  const busy = snapshotDraftBusy(looked, drafts, awaitingSet, endedSet);
  if (!drafts) return busy;
  const removedSources = new Set<string>();
  for (const draft of drafts.byPath.values()) {
    if (draft.removes) for (const from of draft.removes.keys()) removedSources.add(from);
  }
  for (const [path, entry] of looked.files) {
    if (entry.sent === undefined) continue;
    if (
      awaitingSet.has(path) ||
      endedSet.has(path) ||
      removedSources.has(path) ||
      input.deferredRenameSources?.has(path) === true ||
      input.keepPaths?.has(path) === true
    ) {
      continue;
    }
    const draft = drafts.byPath.get(path);
    if (input.inGroup(path) && draft?.inGroup !== true) continue;
    const facts = fileFactsOf(looked, path, input.isRemoteRoom);
    if (isClean(facts) || facts.publishedMoved) continue;
    if (draft !== undefined) {
      if (draft.blob !== null && draft.blob === entry.sent && (draft.removes?.size ?? 0) === 0 && follows(draft, input.login, facts, input.policyFor(path, draft))) {
        busy.delete(path);
      }
    } else if (input.committed.has(changeKey({ kind: "new", path })) && entry.sentAt !== undefined && input.now - entry.sentAt <= RECENT_COMMITTED_MS) {
      busy.delete(path);
    }
  }
  return busy;
};

export const excludeRenameLooked = (looked: Looked, skip: Iterable<string>): Looked => {
  const skipSet = skip instanceof Set ? skip : new Set(skip);
  if (skipSet.size === 0) return looked;
  const removed = new Set<string>();
  for (const draft of looked.drafts?.byPath.values() ?? []) {
    if (draft.removes) for (const from of draft.removes.keys()) removed.add(from);
  }
  return { ...looked, files: new Map([...looked.files].filter(([path]) => !skipSet.has(path) || removed.has(path))) };
};

export const pruneSentRecently = (sentRecently: Map<string, number>, looked: Looked, now: number): void => {
  for (const [path, at] of [...sentRecently]) {
    if (
      now - at > RECENT_COMMITTED_MS ||
      looked.drafts?.byPath.has(path) === true ||
      (looked.files.has(path) && looked.files.get(path)?.sent === undefined && at < now)
    ) {
      sentRecently.delete(path);
    }
  }
};

export const isSkippableDraftMerge = (
  kind: Case["kind"],
  path: string,
  entry: Pick<CacheEntry, "sha"> | undefined,
  draftBlob: string | null,
  isTold: (path: string, blob: string | null) => boolean,
  isEditHeld: (path: string, sha: string) => boolean,
  cleanMerges: ReadonlyMap<string, string>,
): boolean => {
  if ((kind === "merge" || kind === "meet") && isTold(path, draftBlob)) return true;
  return kind === "merge" && entry !== undefined && !isEditHeld(path, entry.sha) && cleanMerges.get(path) === `${entry.sha}|${draftBlob ?? ""}`;
};

export interface AdmitDraftReadsEnv {
  looked: Looked;
  paths: ReadonlySet<string>;
  drafts: NonNullable<Looked["drafts"]>;
  skip: ReadonlySet<string>;
  ports: Pick<StayPorts, "documentFor" | "inGroup" | "login">;
  transitMs: number;
  draftsPerPass: number;
  textsPerPass: number;
  cleanMerges: ReadonlyMap<string, string>;
  factsOf: (path: string) => FileFacts;
  policyFor: (path: string, draft: Pick<Draft, "blob">) => StayDrafts;
  hasCollision: (path: string) => boolean;
  isHeldMeet: (kind: Case["kind"], path: string, entry: Pick<CacheEntry, "sha" | "base"> | undefined) => boolean;
  isReady: (path: string) => boolean;
  isTold: (path: string, blob: string | null) => boolean;
  isEditHeld: (path: string, sha: string) => boolean;
  isLeftAlone: (path: string) => Promise<LeftAlone | null>;
}

export const admitDraftReads = async (env: AdmitDraftReadsEnv): Promise<{ asked: Array<{ doc: DocumentRef; sha: string }>; deferred: Set<string> }> => {
  const { looked, paths, drafts, skip, ports } = env;
  const asked: Array<{ doc: DocumentRef; sha: string }> = [];
  const deferred = new Set<string>();
  const seen = new Set<string>();
  let admitted = 0;
  for (const path of paths) {
    if (skip.has(path)) continue;
    const draft = drafts.byPath.get(path);
    const doc = ports.documentFor(path);
    if (!draft || !draft.blob || !doc || (ports.inGroup(path) && draft.inGroup !== true)) continue;
    const entry = looked.files.get(path);
    if (isFreshLocalUntitled(path, entry)) continue;
    if (!entry && env.hasCollision(path)) continue;
    if (entry?.sent !== undefined && !(drafts.asOf !== undefined && drafts.asOf > (entry.sentAt ?? 0) + env.transitMs)) continue;
    const kind = draftCase({ file: env.factsOf(path), draft, login: ports.login(), policy: env.policyFor(path, draft), leftAlone: null, ended: null }).kind;
    const readsDraft = kind === "take" || kind === "create" || kind === "merge" || env.isHeldMeet(kind, path, entry);
    if (!readsDraft || !env.isReady(path) || isSkippableDraftMerge(kind, path, entry, draft.blob, env.isTold, env.isEditHeld, env.cleanMerges)) continue;
    if ((await env.isLeftAlone(path)) !== null) continue;
    if (admitted >= env.draftsPerPass || (!seen.has(draft.blob) && asked.length >= env.textsPerPass)) {
      deferred.add(path);
      continue;
    }
    admitted++;
    if (!seen.has(draft.blob)) {
      seen.add(draft.blob);
      asked.push({ doc, sha: draft.blob });
    }
  }
  return { asked, deferred };
};

export interface FlushHeardEnv {
  getLooked: () => Looked | null;
  sentRecently: ReadonlyMap<string, number>;
  heardLater: Set<string>;
  heardAwaitingLook: Set<string>;
  handled?: Set<string>;
  isCurrent: () => boolean;
  canRun: () => boolean;
  policy: () => StayDrafts;
  markShasRead: (path: string) => void;
  readOne: (looked: Looked, path: string) => Promise<{ changed: number; rescan: boolean; wake: number | null }>;
  onWake: (wake: number) => void;
  onDiagnose: () => void;
}

export const flushHeardQueue = async (env: FlushHeardEnv): Promise<{ changed: number; rescan: boolean }> => {
  let changed = 0;
  let rescan = false;
  if (!env.canRun()) return { changed, rescan };
  let count = 0;
  for (const path of [...env.heardLater]) {
    const cur = env.getLooked();
    if (!cur || count >= LIVE_HEARD_PER_PASS || !env.isCurrent() || !env.canRun()) break;
    env.heardLater.delete(path);
    count++;
    if (env.policy() === "mine") {
      env.markShasRead(path);
      rescan = true;
      continue;
    }
    const known =
      cur.drafts?.byPath.has(path) === true ||
      (cur.files.get(path)?.sent !== undefined && !env.sentRecently.has(path)) ||
      cur.rows.some((one) => one.change.path === path && one.review?.reviewBranch != null);
    if (!known) {
      env.heardAwaitingLook.add(path);
      rescan = true;
      continue;
    }
    env.heardAwaitingLook.delete(path);
    try {
      const done = await env.readOne(cur, path);
      if (!env.isCurrent()) break;
      env.handled?.add(path);
      env.markShasRead(path);
      if (done.wake !== null) env.onWake(done.wake);
      changed += done.changed;
      rescan ||= done.rescan;
    } catch {
      env.onDiagnose();
    }
  }
  return { changed, rescan };
};

export const copyBusyPaths = (
  looked: Looked,
  data: Pick<StayData, "seen" | "endedOwn">,
  copyPaths: ReadonlySet<string>,
  copyLower: ReadonlySet<string>,
  extra?: Omit<PreDraftBusyInput, "looked" | "awaiting" | "endedKeys" | "keepPaths">,
): Set<string> => {
  const draftBusy = extra
    ? computeBusyBeforeDraftRun({ ...extra, looked, awaiting: [], endedKeys: Object.keys(data.endedOwn ?? {}), keepPaths: copyPaths })
    : snapshotDraftBusy(looked, looked.drafts, [], Object.keys(data.endedOwn ?? {}));
  const busy = new Set<string>([
    ...copyPaths,
    ...inboundActivePaths(looked, data.seen),
    ...draftBusy,
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

export const matchesDraftBlobOnDisk = async (
  path: string,
  same: CacheEntry,
  draftBlob: string,
  crlfMiss: Map<string, string>,
  isRemoteRoomBlob: (path: string, diskSha: string, draftBlob: string) => boolean,
  readVault: (path: string) => Promise<string | null>,
  isCurrent: () => boolean,
): Promise<boolean> => {
  if (same.sha === draftBlob || isRemoteRoomBlob(path, same.sha, draftBlob) || same.same === draftBlob) return true;
  const pair = `${same.sha}|${draftBlob}`;
  if (crlfMiss.get(path) === pair) return false;
  const text = await readVault(path);
  if (!isCurrent() || text === null || gitBlobShaOfText(text) !== same.sha) return false;
  if (gitBlobShaOfText(toLf(text)) === draftBlob || (hasBom(text) && gitBlobShaOfText(stripBom(toLf(text))) === draftBlob)) return true;
  crlfMiss.set(path, pair);
  return false;
};

export const readDraftMergeBase = async (
  ports: Pick<StayPorts, "localSentBase" | "baseText" | "blobText" | "draftBase">,
  path: string,
  doc: DocumentRef,
  entry: Pick<CacheEntry, "sent" | "base"> | undefined,
  draft: Pick<Draft, "branch" | "prNumber" | "inGroup">,
  onCountRead?: () => void,
): Promise<string | null> => {
  if (ports.localSentBase) {
    const local = await ports.localSentBase(path, doc, draft);
    if (local !== null) return local;
  }
  if (entry?.sent !== undefined) {
    const cached = ports.baseText(path, entry.sent);
    if (cached !== null) return cached;
    onCountRead?.();
    return ports.blobText(doc, entry.sent);
  }
  if (!entry || entry.base === null || !ports.draftBase) return null;
  onCountRead?.();
  const fork = await ports.draftBase(doc, draft.branch);
  if (fork === null) return null;
  const matchesBase = gitBlobShaOfText(fork.base) === entry.base;
  const matchesMain = fork.main !== "" && gitBlobShaOfText(fork.main) === entry.base;
  return matchesBase || matchesMain ? fork.base : null;
};

export interface EditRulesEnv {
  looked: Looked;
  data: Pick<StayData, "editsHeld" | "heldWhy" | "deletedAt" | "typed">;
  login: string;
  quitGraceMs: number;
  beganAt: number;
  isSuspect: (path: string) => boolean;
  isRemoteRoom: (path: string, sha: string) => boolean;
  isDraftPending: (path: string) => boolean;
  conflicts: Map<string, string>;
  conflictKey: (looked: Looked, path: string) => string;
  waitFor: (path: string, mtime: number, sentAt?: number) => number;
  changedByPersonSince: (path: string, since: number, mtime: number, typedAt: number | undefined, sha?: string) => boolean;
}

export const buildEditRules = (env: EditRulesEnv): NonNullable<OutboundInput["edits"]> | null => {
  const { looked, data } = env;
  if (!looked.drafts) return null;
  const held = data.editsHeld ?? {};
  const loginLower = env.login.toLowerCase();
  return {
    own: (row) => {
      const entry = looked.files.get(row.change.path);
      return entry !== undefined && !env.isRemoteRoom(row.change.path, entry.sha) && (agreedOf(entry) === undefined || entry.sha !== agreedOf(entry));
    },
    held: (row) => {
      const path = row.change.path;
      const entry = looked.files.get(path);
      if (entry === undefined || held[path] === entry.sha || env.isDraftPending(path)) return true;
      if (held[path] !== undefined) {
        const why = data.heldWhy?.[path];
        const draft = looked.drafts?.byPath.get(path);
        if (why === "deleted" && data.deletedAt?.[path] !== undefined && draft === undefined && !looked.repo.has(path)) return true;
        const reopened = draft !== undefined && ((draft.by ?? "").toLowerCase() === loginLower || agreedOf(entry) !== undefined);
        if (why === "closedElsewhere" && entry.sha !== looked.repo.get(path) && !reopened) return true;
        if (env.isSuspect(path)) return true;
      }
      const conflict = env.conflicts.get(path);
      if (conflict === undefined) return false;
      if (conflict === env.conflictKey(looked, path)) return true;
      env.conflicts.delete(path);
      return false;
    },
    wait: (row) => {
      const entry = looked.files.get(row.change.path);
      return entry === undefined ? 0 : env.waitFor(row.change.path, entry.mtime, entry.sentAt);
    },
    after: (row) => {
      const entry = looked.files.get(row.change.path);
      return entry !== undefined && env.changedByPersonSince(row.change.path, env.beganAt, entry.mtime, data.typed?.[row.change.path]?.at, entry.sha);
    },
    typed: (row) => {
      const mark = data.typed?.[row.change.path];
      const entry = looked.files.get(row.change.path);
      if (mark === undefined || entry === undefined) return false;
      return mark.sha === entry.sha || (entry.mtime >= mark.at - env.quitGraceMs && entry.mtime <= mark.at + env.quitGraceMs);
    },
  };
};

export const writeDraftText = async (
  ports: Pick<StayPorts, "vault" | "notify">,
  activity: Activity,
  path: string,
  mine: string,
  target: string,
  onWait: (path: string) => void,
  options: { confirmed?: boolean; notifyOnFail?: boolean } = {},
): Promise<{ ok: true; text: string; changed: boolean } | { ok: false }> => {
  const targetLf = toLf(target);
  const text = withBomAndEol(targetLf, mine);
  if (toLf(mine) === targetLf || text === mine) return { ok: true, text: mine, changed: false };
  activity.ownWrite(path);
  const written = await ports.vault.process(path, (current) => (current === mine ? text : null), options.confirmed ? { confirmed: true } : undefined);
  if (written !== "written") {
    activity.notWritten(path);
    if (options.notifyOnFail) ports.notify(DRAFT_SAID.notApplied(noteName(path)));
    else onWait(path);
    return { ok: false };
  }
  return { ok: true, text, changed: true };
};

export const observeStayGit = (
  obs: GitObservation | null,
  atStart: boolean,
  state: StayState,
  activity: Activity,
  pendingGitMark: StayGitMark | null,
): { moved: boolean; pendingGitMark: StayGitMark | null; movedAtStart: boolean } => {
  if (obs === null || obs.mark === null) return { moved: false, pendingGitMark, movedAtStart: false };
  if (obs.moved) {
    if (!atStart && state.data.typed) {
      let deleted = false;
      for (const path of Object.keys(state.data.typed)) {
        if (!activity.isSuspect(path)) continue;
        delete state.data.typed[path];
        deleted = true;
      }
      if (deleted) state.save();
    }
    return { moved: true, pendingGitMark: obs.mark, movedAtStart: atStart };
  }
  if (pendingGitMark !== null || activity.hasGit()) return { moved: false, pendingGitMark: obs.mark, movedAtStart: false };
  if (!sameGitMark(state.data.gitMark, obs.mark)) {
    state.data.gitMark = obs.mark;
    state.save();
  }
  return { moved: false, pendingGitMark, movedAtStart: false };
};

export const TYPED_READ_MS = 500;

export interface TypedTouchEnv {
  path: string;
  deferRead: boolean;
  from?: string;
  state: StayState;
  ports: Pick<StayPorts, "now" | "later" | "vault">;
  typedReads: Map<string, () => void>;
  isCurrent: () => boolean;
  isSuspect: (path: string) => boolean;
  isRemoteRoom: (path: string, sha: string) => boolean;
  saveSoon: () => void;
}

export const recordTypedTouch = (env: TypedTouchEnv): void => {
  const { path, deferRead, from, state, ports, typedReads } = env;
  if (from !== undefined) {
    typedReads.get(from)?.();
    typedReads.delete(from);
  }
  const typed = (state.data.typed ??= {});
  const at = ports.now();
  typed[path] = { sha: "", at };
  const keys = Object.keys(typed);
  if (keys.length > TYPED_KEPT) for (const old of keys.sort((a, b) => typed[a]!.at - typed[b]!.at).slice(0, keys.length - TYPED_KEPT)) delete typed[old];
  env.saveSoon();
  const readSha = (): void => {
    void ports.vault.read(path).then((text) => {
      if (text === null || !env.isCurrent() || env.isSuspect(path)) return;
      const sha = gitBlobShaOfText(text);
      if (env.isRemoteRoom(path, sha)) {
        if (state.data.typed?.[path]?.at === at) {
          delete state.data.typed[path];
          env.saveSoon();
        }
        return;
      }
      const mark = state.data.typed?.[path];
      if (mark === undefined || mark.at !== at) return;
      mark.sha = sha;
      env.saveSoon();
    });
  };
  typedReads.get(path)?.();
  typedReads.delete(path);
  if (deferRead) {
    typedReads.set(
      path,
      ports.later(() => {
        typedReads.delete(path);
        readSha();
      }, TYPED_READ_MS),
    );
    return;
  }
  readSha();
};

export interface SendPlannedEnv {
  rows: readonly ChangeRow[];
  looked: Looked;
  generation: number;
  login: string;
  committed: ReadonlySet<string>;
  blockedNew: BlockedNew;
  writesPerFile: number;
  maxTries: number;
  ports: StayPorts;
  state: StayState;
  activity: Activity;
  budget: WriteBudget;
  pace: Pace;
  holds: StayHolds;
  githubHeldBase: Map<string, string | null>;
  conflicts: Map<string, string>;
  retryAt: Map<string, number>;
  tries: Map<string, number>;
  laterTries: Map<string, { count: number; generation: number }>;
  outboundUnsaved: Map<string, { strikes: number; until: number }>;
  sentPaths?: Set<string>;
  onSent?: (path: string) => void;
  isCurrent: () => boolean;
  isDraftPending: (path: string) => boolean;
  memberBranchOf: (path: string) => string | undefined;
  clearDraftConflict: (path: string) => void;
  tellDraftConflict: (path: string, blob: string | null) => void;
  conflictKey: (looked: Looked, path: string) => string;
  deferOutboundUnsaved: (path: string) => void;
  deletedOnGithub: (path: string, at: number) => void;
  scheduleOutbound: (ms: number) => void;
}

export const sendPlannedOutbound = async (env: SendPlannedEnv): Promise<{ sent: number; gaveUp: number; unsure: number }> => {
  const { looked, generation, login, committed, blockedNew, ports, state, activity, budget, pace, holds } = env;
  const { data } = state;
  let sent = 0;
  let gaveUp = 0;
  let unsure = 0;
  for (const row of env.rows) {
    if (!env.isCurrent() || ports.personBusy()) break;
    const entry = looked.files.get(row.change.path);
    if (isFreshLocalUntitled(row.change.path, entry) && UNTITLED_CANVAS.test(row.change.path) && (entry?.size ?? 0) <= BLANK_CANVAS_MAX_BYTES) {
      const canvasText = await ports.vault.read(row.change.path);
      if (!env.isCurrent()) break;
      if (canvasText !== null && isBlankUntitledCanvasText(canvasText)) continue;
    }
    const wait = budget.waitFor(env.writesPerFile);
    if (wait > 0) {
      env.scheduleOutbound(wait);
      break;
    }
    const key = changeKey(row.change);
    const edit = isEdit(row, committed, { looked, login, blockedNew });
    if (edit && (await ports.vault.hasUnsavedText(row.change.path))) {
      if (!env.isCurrent()) break;
      env.deferOutboundUnsaved(row.change.path);
      continue;
    }
    if (!env.isCurrent()) break;
    env.outboundUnsaved.delete(row.change.path);
    const memberBranch = env.memberBranchOf(row.change.path);
    const { result, writes, deletedAt, retryAfterMs, inVault } = await ports.commit(
      row,
      env.isCurrent,
      edit
        ? {
            edit: true as const,
            policy: ports.policy(),
            ...(env.isDraftPending(row.change.path) ? { ended: true as const } : {}),
            ...(memberBranch !== undefined ? { memberBranch } : {}),
            notWritten: (path) => activity.notWritten(path),
            during: (paths, run, left) => activity.during(paths, run, left),
          }
        : undefined,
    );
    if (writes > 0) budget.spend(writes);
    if (!env.isCurrent()) break;
    if ((result === "committed" && inVault !== false) || result === "held" || result === "conflict") delete state.data.typed?.[row.change.path];
    if (result === "committed") {
      budget.succeeded();
      env.retryAt.delete(key);
      env.tries.delete(key);
      env.laterTries.delete(key);
      if (env.conflicts.delete(row.change.path)) env.clearDraftConflict(row.change.path);
      if (inVault === false) env.deferOutboundUnsaved(row.change.path);
      if (inVault !== false || !edit) {
        if (edit) pace.saved(row.change.path);
        else data.committed.push(key);
        env.sentPaths?.add(row.change.path);
        env.onSent?.(row.change.path);
        sent++;
      }
    } else if (result === "deleted") {
      env.deletedOnGithub(row.change.path, deletedAt ?? ports.now());
    } else if (result === "held") {
      if (edit) {
        env.githubHeldBase.set(row.change.path, looked.files.get(row.change.path)?.base ?? null);
        if (holds.holdEdit(looked, row.change.path, "github")) ports.lookAgain();
      } else holds.holdNew(looked, key, row.change.path, "github");
    } else if (result === "conflict") {
      env.conflicts.set(row.change.path, env.conflictKey(looked, row.change.path));
      env.tellDraftConflict(row.change.path, looked.drafts?.byPath.get(row.change.path)?.blob ?? null);
    } else if (result === "limited") {
      budget.limited(retryAfterMs);
      env.scheduleOutbound(Math.max(0, budget.backoff().until - ports.now()));
      state.save();
      break;
    } else if (result === "unsure") {
      env.retryAt.set(key, ports.now() + UNSURE_RETRY_MS);
      unsure++;
    } else if (result === "later") {
      env.retryAt.set(key, ports.now() + stepLaterRetry(env.laterTries, key, generation));
    } else {
      const tried = (env.tries.get(key) ?? 0) + 1;
      env.tries.set(key, tried);
      env.retryAt.set(key, ports.now() + retryWaitFor(RETRY_WAITS_MS, tried));
      if (tried >= env.maxTries) {
        if (edit) {
          if (holds.holdEdit(looked, row.change.path, "tries")) ports.lookAgain();
        } else holds.holdNew(looked, key, row.change.path, "tries");
        gaveUp++;
      }
    }
    state.save();
  }
  return { sent, gaveUp, unsure };
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
