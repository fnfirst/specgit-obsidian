import { draftWorkItems, GROUP_BRANCH_PREFIX, GROUP_PRO_ONLY, inFlightEntries, isGroupBranch, isSomeoneElses, sameLogin, type ChangeSetEntry, type InFlightBranch, type InFlightResponse, type PrInfo } from "../shared/review-flow";
import {
  asksYouOf,
  docItemOf,
  groupItemOf,
  itemsFromInFlight,
  reviewerChips,
  type ActionAnswer,
  type DocExtra,
  type PanelAction,
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

  openComments: (path: string) => number;

  linked: string;

  plansUrl: string;

  active?: { path: string; status: NoteStatus | null; behind: boolean; people?: number | null } | null;

  showChanges: boolean;

  checked: readonly string[];

  notice: StatusNotice | null;

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

export function panelModelOf(input: PanelInput): Built {
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

  const folderOf = (path: string): { folder?: string } => {
    const { folder } = placeUnder(input.linked, path);
    return folder === "" ? {} : { folder };
  };

  const joinable = (item: StatusDoc): StatusDoc => ((item.here?.length ?? 0) > 0 && !item.button && input.vaultHas(item.id) && !input.isLive(item.id) && item.id !== input.active?.path ? { ...item, button: "join" as const } : item);

  const drawn = (path: string, from: Drawn): StatusDoc => {
    rows.set(path, from.acts);
    if (from.url !== null) urls.set(path, from.url);
    const item = docItemOf({ entry: from.entry, branch: branches.get(path) ?? null, facts: from.facts, here: rooms.get(path), viewer, now, extra: { ...from.extra, ...folderOf(path) } });
    const views = input.viewsOf(path);
    const comments = input.openComments(path);
    return joinable({ ...item, ...(views.length > 0 ? { views } : {}), ...(comments > 0 ? { openComments: comments } : {}) });
  };

  const fromChange = (row: ChangeRow): Drawn => {
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
        held: input.holdOf(path),
        ...(told === null ? {} : { reason: told }),

        behind: input.active?.path === path ? input.active.behind : undefined,
        ...(row.change.kind === "renamed" && from ? { renamedFrom: noteName(from) } : {}),
        ...(row.unchanged ? {} : { hasChanges: true }),
      },
    };
  };
  const docs: StatusDoc[] = state.loose.map((row) => drawn(row.change.path, fromChange(row)));

  const openPath = input.active?.path ?? null;
  const unchanged = openPath !== null && !rows.has(openPath) ? input.unchanged?.(openPath) : undefined;
  if (openPath !== null && unchanged?.entry) {
    const { entry } = unchanged;
    docs.push(drawn(openPath, { entry, facts: factsOf(entry.prNumber, unchanged.review?.pr), acts: unchanged, url: entry.prUrl }));
  }

  const branchOf = (id: string): string => Object.entries(flight?.groups ?? {}).find(([, overview]) => overview.id === id)?.[0] ?? `${GROUP_BRANCH_PREFIX}${id}`;
  const groups: StatusGroup[] = state.groups.flatMap((card) => {
    const info = card.group;
    if (!info) return [];
    const { overview } = info;
    rows.set(groupId(overview.id), card);
    for (const file of info.files) if (file.row) members.set(file.path, file.row);
    const branch = branchOf(overview.id);
    const entries = overview.paths.flatMap((path) => (flight?.paths[path] ?? []).filter((one) => one.branch === branch).slice(0, 1));
    const item = groupItemOf({ overview, entries, facts: factsOf(overview.prNumber, card.review?.pr), rooms, viewer, now, ...(input.editingGroup === groupId(overview.id) ? { editing: true } : {}) });
    urls.set(item.id, overview.prUrl);
    return [info.members.length > 0 ? { ...item, hasChanges: true } : item];
  });

  const named = new Set<string>([...docs.map((one) => one.id), ...state.groups.flatMap((card) => card.group?.files.map((file) => file.path) ?? [])]);
  const listed: StatusItem[] = flight
    ? itemsFromInFlight({ inFlight: flight, facts: input.facts, rooms, viewer, now, exclude: named }).flatMap((item): StatusItem[] => {

        if (item.kind === "group") return [];
        const entry = flight.paths[item.id]?.find((one) => one.prUrl);
        if (entry?.prUrl) urls.set(item.id, entry.prUrl);

        const listedItem: StatusDoc = { ...item, ...folderOf(item.id) };
        if (input.vaultHas(item.id)) return [joinable(listedItem)];

        const { check, ...rest } = listedItem;
        return [{ ...(check === "submit" ? rest : listedItem), menu: ["bring-in" as const] }];
      })
    : [];
  const items: StatusItem[] = [...listed, ...docs, ...groups];

  if (flight) {
    for (const entry of inFlightEntries(flight, viewer, flight.base)) {
      if (named.has(entry.path) || entry.group || rows.has(entry.path)) continue;

      if (entry.prNumber <= 0 && !sameLogin(entry.authorLogin, viewer)) continue;
      const found = reviewRowOf(entry, branches.get(entry.path) ?? null, input.docFor(entry.path));
      if (found) rows.set(entry.path, found);
    }
  }

  const active = input.active ?? null;
  const pinned = active ? pinnedOf(input, active, items, state, factsOf, rows) : null;

  const copying = state.copying;
  const newerItems = input.newer.map((path) => ({ id: path, name: noteName(path), ...folderOf(path) }));
  const folds: StatusFold[] = [
    copying ? { id: "not-here" as const, count: copying.total - copying.done, progress: { done: copying.done, total: copying.total } } : { id: "not-here" as const, count: state.missing },
    { id: "newer" as const, count: input.newer.length, ...(newerItems.length > 0 ? { items: newerItems } : {}) },
    { id: "deleted" as const, count: input.heldDeletes },
    { id: "offered" as const, count: input.offered },
  ].filter((fold) => fold.count > 0 || (fold.id === "not-here" && copying !== null));

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
    ...(folds.length > 0 ? { folds } : {}),
    checked: input.checked,
    ...(input.reviewers.length > 0 ? { reviewers: input.reviewers } : {}),
    ...(input.notice ? { notice: input.notice } : {}),
    ...(input.onChecked ? { onChecked: input.onChecked } : {}),
    onAction: input.onAction,
  };
  return { model, units: { rows, members, urls } };
}

function reviewRowOf(entry: ChangeSetEntry, branch: InFlightBranch | null, doc: DocumentRef | null): ChangeRow | null {
  if (!doc) return null;
  const change = { kind: "edited" as const, path: entry.path, sha: "", repoSha: null, mainMoved: false, baseUnknown: true, base: null };
  if (entry.prNumber <= 0) return branch ? { change, doc, review: { reviewBranch: branch.branch, pr: null }, entry: null, unit: entry, unchanged: true } : null;
  const pr: PrInfo = { number: entry.prNumber, url: entry.prUrl, state: entry.isDraft ? "draft" : "open", isDraft: entry.isDraft, authorLogin: entry.authorLogin, requestedReviewers: entry.requestedReviewers };
  return { change, doc, review: { reviewBranch: branch?.branch ?? null, pr }, entry, unit: entry, unchanged: true };
}

function pinnedOf(
  input: PanelInput,
  active: NonNullable<PanelInput["active"]>,
  items: readonly StatusItem[],
  state: ChangesState,
  factsOf: (number: number, pr?: PrInfo | null) => ReviewFacts | null,
  rows: ReadonlyMap<string, ChangeRow>,
): StatusPinned {
  const { path, status } = active;
  const own = items.find((item): item is StatusDoc => item.kind === "doc" && item.id === path);
  const row = rows.get(path) ?? state.rows.find((one) => one.change.path === path);
  const card = state.groups.find((one) => one.group?.files.some((file) => file.path === path));
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
  return {
    id: path,
    name: noteName(path),
    state: own?.state ?? "published",
    ...(own?.when ? { when: own.when } : {}),
    ...(own?.changed === undefined ? {} : { changed: own.changed }),
    people: own?.people ?? [],
    ...(own?.asksYou ? { asksYou: true } : {}),
    here,
    ...(own?.check ? { check: own.check } : {}),
    ...(own?.hasChanges ? { hasChanges: true } : {}),
    showChanges: input.showChanges,
    ...(submitted && facts ? { reviewers: reviewerChips(facts) } : {}),

    ...(state.choices.has(path) || own?.state === "changed-in-both" ? { step: "choose" as const } : {}),
    ...(own?.tipPeople ? { tipPeople: own.tipPeople } : {}),
    ...(card?.group ? { groupId: groupId(card.group.id) } : {}),
    hasReview: own?.hasReview ?? false,
    ...(own?.teammate ? { teammate: true } : {}),

    ...(own?.teammate && !own.hasChanges ? { nothingToSend: true } : {}),
    ...(publishable ? { publishable: true } : {}),
    ...(canApprove ? { canApprove: true } : {}),
    ...(comments > 0 ? { openComments: comments } : {}),
    ...(own?.autoPublish ? { autoPublish: true } : {}),
    ...(own?.reason ? { reason: own.reason } : {}),
    ...(own?.views ? { views: own.views } : {}),
    menu: ["open-in-specgit", "copy-link"],

    plugin: { connected: phase !== "local", joining: phase === "joining", ...(phase === "local" && (active.people ?? 0) > 0 ? { people: active.people! } : {}) },
  };
}
