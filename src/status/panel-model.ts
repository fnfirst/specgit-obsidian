import { draftWorkItems, GROUP_BRANCH_PREFIX, GROUP_PRO_ONLY, inFlightEntries, isGroupBranch, isSomeoneElses, sameLogin, saverWaitingLine, type ChangeSetEntry, type GithubStatusSnapshot, type InFlightBranch, type InFlightResponse, type PrInfo, type SaverStatus } from "../shared/review-flow";
import {
  asksYouOf,
  docItemOf,
  groupItemOf,
  itemsFromInFlight,
  reviewerChips,
  type ActionAnswer,
  type DocExtra,
  type PanelAction,
  type PluginLiveAction,
  type ReviewFacts,
  type StatusDoc,
  type StatusFold,
  type StatusGroup,
  type StatusItem,
  type StatusNotice,
  type StatusPanelModel,
  type StatusPerson,
  type StatusPinned,
  type StatusReviewer,
} from "../shared/status-panel";
import { type ChangeRow, type ChangesState, draftEntry } from "../changes/model";
import { writersOf } from "../changes/aware";
import { type DocumentRef, noteName } from "../mapping";
import { placeUnder } from "../changes/vault-state";
import { phaseOf, type NoteStatus } from "../status";

export const groupId = (id: string): string => `g:${id}`;

export interface PanelInput {
  state: ChangesState;
  viewer: string;
  now: number;
  facts: ReadonlyMap<number, ReviewFacts>;
  flight: InFlightResponse | null;
  rooms: ReadonlyMap<string, readonly string[]>;
  unchanged?: (path: string) => ChangeRow | undefined;
  vaultHas: (path: string) => boolean;
  docFor: (path: string) => DocumentRef | null;
  holdOf: (path: string) => string | null;
  told: (path: string) => string | null;
  both: ReadonlySet<string>;
  viewsOf: (path: string) => readonly ("github" | "difference")[];
  newer: readonly string[];
  heldDeletes: number;
  offered: number;
  isLive: (path: string) => boolean;
  stay?: boolean;
  isPaused?: (path: string) => boolean;
  openComments: (path: string) => number;
  linked: string;
  plansUrl: string;
  active?: { path: string; status: NoteStatus | null; behind: boolean; people?: number | null; saver?: SaverStatus | null } | null;
  showChanges: boolean;
  checked: readonly string[];
  notice: StatusNotice | null;
  githubStatus?: GithubStatusSnapshot | null;
  editingGroup: string | null;
  reviewers: readonly StatusReviewer[];
  readOnly: boolean;
  onAction: (action: PanelAction) => void | Promise<ActionAnswer>;
  onChecked?: (ids: readonly string[]) => void;
}

export interface Units {
  rows: ReadonlyMap<string, ChangeRow>;
  members: ReadonlyMap<string, ChangeRow>;
  urls: ReadonlyMap<string, string>;
}

export interface Built {
  model: StatusPanelModel;
  units: Units;
}

interface Drawn {
  entry: ChangeSetEntry;
  facts: ReviewFacts | null;
  acts: ChangeRow;
  url: string | null;
  extra?: DocExtra;
}

export function factsFromPr(pr: PrInfo | null | undefined): ReviewFacts | null {
  if (!pr) return null;
  const asked = pr.requestedReviewers ?? [];
  return {
    isDraft: pr.isDraft || pr.state === "draft",
    state: pr.state === "merged" || pr.state === "closed" ? pr.state : "open",
    mergeableState: pr.mergeableState ?? null,
    reviewDecision: pr.reviewPolicy?.reviewDecision ?? null,
    requestedReviewers: asked,
    authorLogin: pr.authorLogin ?? null,
    ...(pr.autoMergeEnabled === undefined ? {} : { autoMergeEnabled: pr.autoMergeEnabled }),
    reviewers: asked.map((login) => ({ login, state: "requested" as const })),
  };
}

const peopleOf = (logins: readonly string[] | undefined): StatusPerson[] => (logins ?? []).map((login) => ({ login }));

function branchesOf(flight: InFlightResponse | null, viewer: string): Map<string, InFlightBranch> {
  const branches = new Map<string, InFlightBranch>();
  if (!flight) return branches;
  for (const { path, entry } of draftWorkItems(flight.paths, viewer, flight.base)) if (!branches.has(path)) branches.set(path, entry);
  return branches;
}

function ownListedOf(flight: InFlightResponse | null, viewer: string): Map<string, ChangeSetEntry> {
  const own = new Map<string, ChangeSetEntry>();
  if (!flight) return own;
  const mine = new Set<string>();
  const seen = new Set<string>();
  for (const { path, entry, isViewer } of draftWorkItems(flight.paths, viewer, flight.base)) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (isViewer && !isGroupBranch(entry.branch)) mine.add(path);
  }
  for (const entry of inFlightEntries(flight, viewer, flight.base)) if (mine.has(entry.path)) own.set(entry.path, entry);
  return own;
}

function hereOf(status: NoteStatus | null): StatusPerson[] {
  return (status?.here ?? []).flatMap((one) => ((one.login ?? one.name) === "" ? [] : [{ login: one.login ?? one.name, ...(one.picture ? { avatarUrl: one.picture } : {}) }]));
}

export type VaultPanelInput = Pick<
  PanelInput,
  | "state"
  | "viewer"
  | "now"
  | "facts"
  | "flight"
  | "rooms"
  | "vaultHas"
  | "docFor"
  | "holdOf"
  | "told"
  | "both"
  | "viewsOf"
  | "newer"
  | "heldDeletes"
  | "offered"
  | "isLive"
  | "openComments"
  | "linked"
  | "editingGroup"
>;

export type ActivePanelInput = Pick<
  PanelInput,
  | "state"
  | "viewer"
  | "unchanged"
  | "holdOf"
  | "isLive"
  | "stay"
  | "isPaused"
  | "openComments"
  | "plansUrl"
  | "active"
  | "showChanges"
  | "checked"
  | "notice"
  | "githubStatus"
  | "reviewers"
  | "readOnly"
  | "onAction"
  | "onChecked"
>;

export interface VaultPanelBase {
  readonly items: StatusItem[];
  readonly listedCount: number;
  readonly docsCount: number;
  readonly folds: StatusFold[];
  readonly units: Units;
  readonly loosePaths: ReadonlySet<string>;
  readonly looseByPath: ReadonlyMap<string, ChangeRow>;
  readonly rowByPath: ReadonlyMap<string, ChangeRow>;
  readonly groupByPath: ReadonlyMap<string, ChangeRow>;
  readonly docIndexById: ReadonlyMap<string, number>;
  readonly holdById: ReadonlyMap<string, string | null>;
  readonly joinCandidates: ReadonlyArray<{ index: number; raw: StatusDoc }>;
  readonly factsOf: (number: number, pr?: PrInfo | null) => ReviewFacts | null;
  readonly drawDoc: (path: string, from: Drawn, holdOverride?: string | null) => StatusDoc;
  readonly fromChange: (row: ChangeRow, behind?: boolean) => Drawn;
}

export function vaultPanelOf(input: VaultPanelInput): VaultPanelBase {
  const { state, viewer, now } = input;
  const flight = input.flight;
  const branches = branchesOf(flight, viewer);
  const ownListed = ownListedOf(flight, viewer);
  const firstListed = new Map(flight ? inFlightEntries(flight, viewer, flight.base).map((entry) => [entry.path, entry] as const) : []);
  const rooms = new Map(Array.from(input.rooms, ([path, logins]) => [path, peopleOf(logins)] as const));
  const factsOf = (number: number, pr?: PrInfo | null): ReviewFacts | null => (number > 0 ? (input.facts.get(number) ?? factsFromPr(pr)) : null);
  const rows = new Map<string, ChangeRow>();
  const members = new Map<string, ChangeRow>();
  const urls = new Map<string, string>();
  const loosePaths = new Set<string>();
  const looseByPath = new Map<string, ChangeRow>();
  const rowByPath = new Map<string, ChangeRow>();
  const holdById = new Map<string, string | null>();
  for (const row of state.rows) if (!rowByPath.has(row.change.path)) rowByPath.set(row.change.path, row);

  const folderOf = (path: string): { folder?: string } => {
    const { folder } = placeUnder(input.linked, path);
    return folder === "" ? {} : { folder };
  };
  const drawDoc = (path: string, from: Drawn, holdOverride?: string | null): StatusDoc => {
    const held = from.extra?.held !== undefined ? from.extra.held : holdOverride !== undefined ? holdOverride : input.holdOf(path);
    const item = docItemOf({ entry: from.entry, branch: branches.get(path) ?? null, facts: from.facts, here: rooms.get(path), viewer, now, extra: { ...from.extra, held, ...folderOf(path) } });
    const views = input.viewsOf(path);
    const comments = input.openComments(path);
    return { ...item, ...(views.length > 0 ? { views } : {}), ...(comments > 0 ? { openComments: comments } : {}) };
  };
  const drawn = (path: string, from: Drawn): StatusDoc => {
    rows.set(path, from.acts);
    if (from.url !== null) urls.set(path, from.url);
    const held = from.extra?.held !== undefined ? from.extra.held : input.holdOf(path);
    holdById.set(path, held);
    return drawDoc(path, from, held);
  };
  const fromChange = (row: ChangeRow, behind?: boolean): Drawn => {
    const path = row.change.path;
    const listedOwn = row.entry === null ? (ownListed.get(path) ?? null) : null;
    const settled = state.aware?.settled.has(path) === true;
    const branch = branches.get(path) ?? null;
    const wroteIn = state.aware?.own.has(path) === true || (branch !== null && writersOf(branch).some((login) => sameLogin(login, viewer)));
    const theirs = listedOwn === null && settled && !wroteIn && (row.entry === null || isSomeoneElses(row.entry, viewer)) ? (firstListed.get(path) ?? null) : null;
    if (theirs) {
      const reviewRow = theirs.prNumber > 0 ? reviewRowOf(theirs, branch, input.docFor(path)) : null;
      return { entry: theirs, facts: theirs.prNumber > 0 ? (input.facts.get(theirs.prNumber) ?? null) : null, acts: reviewRow ?? row, url: theirs.prUrl || null };
    }
    const reviewed = row.entry ?? listedOwn ?? row.unit;
    const facts = row.entry ? factsOf(row.entry.prNumber, row.review?.pr) : listedOwn ? factsOf(listedOwn.prNumber) : null;
    const yours = listedOwn === null && isSomeoneElses(reviewed, viewer) && (!settled || (facts?.isDraft ?? reviewed.isDraft));
    const unsent = listedOwn === null && !settled && (row.entry === null || yours);
    const deleted = row.change.kind === "deleted";
    const { from } = row.change;
    const told = input.told(path);
    return {
      entry: yours ? draftEntry(row.change) : reviewed,
      facts: yours ? null : facts,
      acts: row,
      url: row.entry ? row.entry.prUrl : listedOwn?.prUrl || null,
      extra: {
        deleted,
        edited: unsent && !deleted,
        changedInBoth: state.choices.has(path) || input.both.has(path) || (unsent && row.change.mainMoved),
        ...(told === null ? {} : { reason: told }),
        behind,
        ...(row.change.kind === "renamed" && from ? { renamedFrom: noteName(from) } : {}),
        ...(row.unchanged ? {} : { hasChanges: true }),
      },
    };
  };
  const docs: StatusDoc[] = state.loose.map((row) => {
    loosePaths.add(row.change.path);
    looseByPath.set(row.change.path, row);
    return drawn(row.change.path, fromChange(row));
  });

  const groupByPath = new Map<string, ChangeRow>();
  const branchOf = (id: string): string => Object.entries(flight?.groups ?? {}).find(([, overview]) => overview.id === id)?.[0] ?? `${GROUP_BRANCH_PREFIX}${id}`;
  const groups: StatusGroup[] = state.groups.flatMap((card) => {
    const info = card.group;
    if (!info) return [];
    const { overview } = info;
    rows.set(groupId(overview.id), card);
    for (const file of info.files) {
      if (file.row) members.set(file.path, file.row);
      if (!groupByPath.has(file.path)) groupByPath.set(file.path, card);
    }
    const branch = branchOf(overview.id);
    const entries = overview.paths.flatMap((path) => (flight?.paths[path] ?? []).filter((one) => one.branch === branch).slice(0, 1));
    const item = groupItemOf({ overview, entries, facts: factsOf(overview.prNumber, card.review?.pr), rooms, viewer, now, ...(input.editingGroup === groupId(overview.id) ? { editing: true } : {}) });
    urls.set(item.id, overview.prUrl);
    return [info.members.length > 0 ? { ...item, hasChanges: true } : item];
  });

  const named = new Set<string>([...docs.map((one) => one.id), ...groupByPath.keys()]);
  const listed: StatusItem[] = flight
    ? itemsFromInFlight({
        inFlight: flight,
        facts: input.facts,
        rooms,
        viewer,
        now,
        exclude: named,
        holdOf: (path) => {
          const held = input.vaultHas(path) ? input.holdOf(path) : null;
          holdById.set(path, held);
          return held;
        },
      }).flatMap((item): StatusItem[] => {
        if (item.kind === "group") return [];
        const entry = flight.paths[item.id]?.find((one) => one.prUrl);
        if (entry?.prUrl) urls.set(item.id, entry.prUrl);
        const listedItem: StatusDoc = { ...item, ...folderOf(item.id) };
        if (input.vaultHas(item.id)) return [listedItem];
        const { check, ...rest } = listedItem;
        return [{ ...(check === "submit" ? rest : listedItem), bringIn: true }];
      })
    : [];
  const items: StatusItem[] = [...listed, ...docs, ...groups];
  const docIndexById = new Map<string, number>();
  const joinCandidates: Array<{ index: number; raw: StatusDoc }> = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind !== "doc") continue;
    if (!docIndexById.has(item.id)) docIndexById.set(item.id, index);
    if ((item.here?.length ?? 0) > 0 && !item.button && input.vaultHas(item.id)) {
      joinCandidates.push({ index, raw: item });
      if (!input.isLive(item.id)) items[index] = { ...item, button: "join" as const };
    }
  }
  if (flight) {
    for (const entry of inFlightEntries(flight, viewer, flight.base)) {
      if (named.has(entry.path) || entry.group || rows.has(entry.path)) continue;
      if (entry.prNumber <= 0 && !sameLogin(entry.authorLogin, viewer)) continue;
      const found = reviewRowOf(entry, branches.get(entry.path) ?? null, input.docFor(entry.path));
      if (found) rows.set(entry.path, found);
    }
  }

  const copying = state.copying;
  const newerItems = input.newer.map((path) => ({ id: path, name: noteName(path), ...folderOf(path) }));
  const folds: StatusFold[] = [
    copying ? { id: "not-here" as const, count: copying.total - copying.done, progress: { done: copying.done, total: copying.total } } : { id: "not-here" as const, count: state.missing },
    { id: "newer" as const, count: input.newer.length, ...(newerItems.length > 0 ? { items: newerItems } : {}) },
    { id: "deleted" as const, count: input.heldDeletes },
    { id: "offered" as const, count: input.offered },
  ].filter((fold) => fold.count > 0 || (fold.id === "not-here" && copying !== null));

  return {
    items,
    listedCount: listed.length,
    docsCount: docs.length,
    folds,
    units: { rows, members, urls },
    loosePaths,
    looseByPath,
    rowByPath,
    groupByPath,
    docIndexById,
    holdById,
    joinCandidates,
    factsOf,
    drawDoc,
    fromChange,
  };
}

export function panelModelFromVault(base: VaultPanelBase, input: ActivePanelInput): Built {
  const { state } = input;
  const active = input.active ?? null;
  const openPath = active?.path ?? null;
  const activeHold = openPath !== null ? input.holdOf(openPath) : null;
  let items = base.items;
  let units = base.units;
  let shifted = false;
  let activeReplaced = false;

  const unchanged = openPath !== null && !base.loosePaths.has(openPath) ? input.unchanged?.(openPath) : undefined;
  if (openPath !== null && unchanged?.entry) {
    const { entry } = unchanged;
    const doc = base.drawDoc(openPath, { entry, facts: base.factsOf(entry.prNumber, unchanged.review?.pr), acts: unchanged, url: entry.prUrl }, activeHold);
    const listedSlice = base.items.slice(0, base.listedCount).filter((one) => !(one.kind === "doc" && one.id === openPath));
    const docsSlice = base.items.slice(base.listedCount, base.listedCount + base.docsCount);
    const groupsSlice = base.items.slice(base.listedCount + base.docsCount);
    items = [...listedSlice, ...docsSlice, doc, ...groupsSlice];
    const nextRows = new Map(base.units.rows);
    nextRows.set(openPath, unchanged);
    const nextUrls = new Map(base.units.urls);
    if (entry.prUrl !== null) nextUrls.set(openPath, entry.prUrl);
    units = { rows: nextRows, members: base.units.members, urls: nextUrls };
    shifted = true;
  }

  if (!shifted && openPath !== null) {
    const looseRow = base.looseByPath.get(openPath);
    const holdChanged = looseRow !== undefined && activeHold !== (base.holdById.get(openPath) ?? null);
    if (looseRow && (active?.behind === true || holdChanged)) {
      const at = base.docIndexById.get(openPath);
      if (at !== undefined) {
        const updated = base.drawDoc(openPath, base.fromChange(looseRow, active?.behind === true), activeHold);
        items = [...base.items];
        items[at] = updated;
        activeReplaced = true;
      }
    }
  }

  if (base.joinCandidates.length > 0) {
    for (const { index, raw } of base.joinCandidates) {
      if (activeReplaced && raw.id === openPath) continue;
      const at = shifted ? items.findIndex((one) => one.kind === "doc" && one.id === raw.id) : index;
      if (at < 0) continue;
      const current = items[at] as StatusDoc;
      const wantJoin = !input.isLive(raw.id) && raw.id !== openPath;
      if ((current.button === "join") === wantJoin) continue;
      if (items === base.items) items = [...base.items];
      items[at] = wantJoin ? { ...raw, button: "join" as const } : raw;
    }
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind !== "doc") continue;
    const comments = input.openComments(item.id);
    if ((item.openComments ?? 0) === comments) continue;
    if (items === base.items) items = [...base.items];
    if (comments > 0) items[index] = { ...item, openComments: comments };
    else {
      const { openComments: _, ...rest } = item;
      items[index] = rest;
    }
  }

  let ownDoc: StatusDoc | undefined;
  if (openPath !== null) {
    const at = shifted ? items.findIndex((one) => one.kind === "doc" && one.id === openPath) : base.docIndexById.get(openPath);
    ownDoc = at !== undefined && at >= 0 ? (items[at] as StatusDoc) : undefined;
  }

  const pinned = active ? pinnedOf(input, active, activeHold, ownDoc, base.rowByPath, base.groupByPath, base.factsOf, units.rows) : null;
  const offline = state.phase === "offline";
  const running = state.doing?.kind;
  const model: StatusPanelModel = {
    ...(state.phase === "loading" || state.phase === "signed-out" ? { loading: true } : {}),
    ...(offline ? { offline: true } : {}),
    ...(offline && items.length === 0 && !pinned ? { loadFailed: true } : {}),
    ...(state.busy ? { busy: true } : {}),
    ...(running ? { running } : {}),
    ...(state.groupsLocked ? { grouping: { reason: GROUP_PRO_ONLY.reason, link: { label: GROUP_PRO_ONLY.upgrade, href: input.plansUrl } } } : {}),
    ...(!state.groupsOn && !state.groupsLocked ? { groupsOff: true } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(pinned ? { pinned } : {}),
    items,
    ...(base.folds.length > 0 ? { folds: base.folds } : {}),
    checked: input.checked,
    ...(input.reviewers.length > 0 ? { reviewers: input.reviewers } : {}),
    ...(input.notice ? { notice: input.notice } : {}),
    ...(input.githubStatus ? { githubStatus: input.githubStatus } : {}),
    ...(input.onChecked ? { onChecked: input.onChecked } : {}),
    onAction: input.onAction,
  };
  return { model, units };
}

export function panelModelOf(input: PanelInput): Built {
  return panelModelFromVault(vaultPanelOf(input), input);
}

function reviewRowOf(entry: ChangeSetEntry, branch: InFlightBranch | null, doc: DocumentRef | null): ChangeRow | null {
  if (!doc) return null;
  const change = { kind: "edited" as const, path: entry.path, sha: "", repoSha: null, mainMoved: false, baseUnknown: true, base: null };
  if (entry.prNumber <= 0) return branch ? { change, doc, review: { reviewBranch: branch.branch, pr: null }, entry: null, unit: entry, unchanged: true } : null;
  const pr: PrInfo = { number: entry.prNumber, url: entry.prUrl, state: entry.isDraft ? "draft" : "open", isDraft: entry.isDraft, authorLogin: entry.authorLogin, requestedReviewers: entry.requestedReviewers };
  return { change, doc, review: { reviewBranch: branch?.branch ?? null, pr }, entry, unit: entry, unchanged: true };
}

function pinnedOf(
  input: ActivePanelInput,
  active: NonNullable<ActivePanelInput["active"]>,
  hold: string | null,
  own: StatusDoc | undefined,
  rowByPath: ReadonlyMap<string, ChangeRow>,
  groupByPath: ReadonlyMap<string, ChangeRow>,
  factsOf: (number: number, pr?: PrInfo | null) => ReviewFacts | null,
  rows: ReadonlyMap<string, ChangeRow>,
): StatusPinned {
  const { path, status } = active;
  const { state } = input;
  const row = rows.get(path) ?? rowByPath.get(path);
  const card = groupByPath.get(path);
  const memberRow = card?.group?.files.find((file) => file.path === path)?.row ?? null;
  const groupedBehind =
    card?.group !== undefined &&
    memberRow !== null &&
    !card.group.overview.ending &&
    (active.behind || (card.group.overview.hold === "behind" && card.group.overview.holdPaths.includes(path)));
  const entry = row?.entry ?? null;
  const facts = entry ? factsOf(entry.prNumber, row?.review?.pr) : null;
  const submitted = entry !== null && facts !== null && !facts.isDraft;
  const here = hereOf(status);
  const phase = phaseOf(status);
  const author = entry?.authorLogin ?? facts?.authorLogin ?? null;
  const isMine = author === null || sameLogin(author, input.viewer);
  const publishable = entry !== null && entry.prNumber > 0 && isMine && (own?.state === "in-review" || own?.state === "changes-requested");
  const canApprove = submitted && entry !== null && facts?.state === "open" && !isMine && !asksYouOf(entry, facts, input.viewer);
  const comments = input.openComments(path);
  const saver = active.saver ?? row?.review?.saver ?? memberRow?.review?.saver ?? null;
  const warning = saver?.state === "waiting" ? saverWaitingLine(saver.reason) : null;
  const paused = input.stay === true && input.isPaused?.(path) === true;
  const publishedHeld = own === undefined && !state.choices.has(path) && !groupedBehind && hold !== null;
  const noChangesToShow = publishedHeld && row === undefined && memberRow === null;
  const reason = own?.reason ?? (publishedHeld ? hold : undefined);
  const pluginAction: PluginLiveAction | undefined =
    !input.stay || phase === "joining"
      ? undefined
      : phase === "live"
        ? "work-offline"
        : phase !== "local"
          ? "disconnect"
          : paused
            ? "resume-sync"
            : "connect";
  return {
    id: path,
    name: noteName(path),
    state: own?.state ?? (state.choices.has(path) ? "changed-in-both" : groupedBehind ? "out-of-date" : hold !== null ? "held" : "published"),
    ...(own?.when ? { when: own.when } : {}),
    ...(own?.changed === undefined ? {} : { changed: own.changed }),
    people: own?.people ?? [],
    ...(own?.asksYou ? { asksYou: true } : {}),
    here,
    ...(own?.check ? { check: own.check } : {}),
    ...(publishedHeld ? { lane: "none" as const } : {}),
    ...(own?.hasChanges ? { hasChanges: true } : {}),
    ...(noChangesToShow ? { hideChanges: true } : {}),
    showChanges: input.showChanges,
    ...(submitted && facts ? { reviewers: reviewerChips(facts) } : {}),
    ...(state.choices.has(path) || own?.state === "changed-in-both" ? { step: "choose" as const } : {}),
    ...(own?.tipPeople ? { tipPeople: own.tipPeople } : {}),
    ...(card?.group ? { groupId: groupId(card.group.id) } : {}),
    hasReview: own?.hasReview ?? false,
    ...(own?.draft || (groupedBehind && card?.group?.overview.isDraft) ? { draft: true } : {}),
    ...(own?.approved || facts?.reviewDecision === "approved" ? { approved: true } : {}),
    ...(own?.teammate ? { teammate: true } : {}),
    ...(own?.teammate && !own.hasChanges ? { nothingToSend: true } : {}),
    ...(publishable ? { publishable: true } : {}),
    ...(canApprove ? { canApprove: true } : {}),
    ...(comments > 0 ? { openComments: comments } : {}),
    ...(own?.autoPublish ? { autoPublish: true } : {}),
    ...(reason ? { reason } : {}),
    ...(warning ? { warning } : {}),
    ...(own?.views ? { views: own.views } : {}),
    menu: ["open-in-specgit", "copy-link"],
    plugin: {
      connected: phase !== "local",
      joining: phase === "joining",
      ...(pluginAction ? { action: pluginAction } : {}),
      ...(phase === "local" && (active.people ?? 0) > 0 ? { people: active.people! } : {}),
    },
  };
}
