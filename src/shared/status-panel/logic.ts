import type { Lane, CheckKind, StatusChipKey, StatusDoc, StatusFold, StatusGroup, StatusItem, StatusPanelModel, StatusPerson, StatusPinned } from "./types";

export const DRAW_LIMIT = 20;
export const ASK_ABOVE = 5;

export const LANES: readonly Exclude<Lane, "none">[] = ["approve", "publish", "drafts", "others"];

const KIND_OF_LANE: Partial<Record<Lane, CheckKind>> = { approve: "approve", publish: "publish", drafts: "submit" };
const LANE_OF_KIND: Record<CheckKind, Lane> = { approve: "approve", publish: "publish", submit: "drafts" };

export const loginsOf = (people: readonly (string | StatusPerson)[] | undefined): string[] =>
  (people ?? []).map((one) => (typeof one === "string" ? one : one.login)).filter((login) => login !== "you");

export function laneOf(item: { lane?: Lane; check?: CheckKind; state?: StatusDoc["state"]; asksYou?: boolean; teammate?: boolean; draft?: boolean; here?: readonly unknown[] }): Lane {
  if (item.lane) return item.lane;
  if (item.check) return LANE_OF_KIND[item.check];
  switch (item.state) {
    case "out-of-date":
      return item.teammate ? "others" : item.draft ? "drafts" : "publish";
    case "ready":
      return item.teammate ? "others" : "publish";
    case "held":
    case "changes-requested":
    case "changed-in-both":
    case "deleted":
    case "edited":
    case "draft":
      return item.teammate ? "others" : "drafts";
    case "in-review":
      return item.asksYou ? "approve" : "others";
    default:
      return "none";
  }
}

export function pinnedCheck(pinned: StatusPinned): CheckKind | undefined {
  if (pinned.check) return pinned.check;
  if (pinned.nothingToSend) return pinned.state === "in-review" && pinned.asksYou ? "approve" : undefined;
  const unsent = pinned.state === "draft" || pinned.state === "edited";
  if (unsent && pinned.propose) return undefined;
  if (unsent) return "submit";
  if (pinned.state === "in-review" && pinned.asksYou) return "approve";
  if (pinned.state === "ready") return "publish";
  return undefined;
}

export interface Entry {
  item: StatusItem;
  lane: Lane;
  open: boolean;
  live: boolean;
  needs: boolean;
  check?: CheckKind;
}

export interface Checkable {
  id: string;
  name: string;
  kind: CheckKind;
  documents: number;
  isGroup: boolean;
  isDraft: boolean;
  hasChanges: boolean;
  isOpen: boolean;
}

export interface Layout {
  pinned: StatusPinned | null;
  entries: readonly Entry[];
  byLane: Readonly<Record<Lane, readonly Entry[]>>;
  all: readonly Entry[];
  live: readonly Entry[];
  counts: Readonly<Record<Exclude<Lane, "none">, number>>;
  empty: boolean;
}

const byChange = (entries: readonly Entry[]): Entry[] => [...entries].sort((a, b) => Number(b.needs) - Number(a.needs) || (b.item.changed ?? 0) - (a.item.changed ?? 0));
const liveFirst = (entries: readonly Entry[]): Entry[] => [...entries].sort((a, b) => Number(b.needs) - Number(a.needs) || Number(b.live) - Number(a.live));

export function layoutOf(model: StatusPanelModel): Layout {
  const pinned = model.pinned ?? null;
  const seen = new Set<string>();
  const needs = new Set(model.notice?.ids ?? []);
  const entries: Entry[] = [];
  const add = (item: StatusItem, open: boolean, ownCheck = false) => {
    const ids = item.kind === "group" ? [item.id, ...item.members.map((member) => member.id)] : [item.id];
    if (ids.some((id) => seen.has(id))) return;
    for (const id of ids) seen.add(id);
    const checkOf = open && pinned && !ownCheck ? pinnedCheck(pinned) : item.check;
    entries.push({ item, lane: laneOf({ ...item, check: checkOf }), open, live: loginsOf(item.here).length > 0, needs: needs.has(item.id), check: model.readOnly ? undefined : checkOf });
  };
  const openGroup = pinned?.groupId ? model.items.find((item) => item.kind === "group" && item.id === pinned.groupId) : undefined;
  if (openGroup) add(openGroup, true, true);
  else if (pinned) {
    add(
      {
        kind: "doc",
        id: pinned.id,
        name: pinned.name,
        state: pinned.state,
        people: pinned.people,
        asksYou: pinned.asksYou,
        when: pinned.when,
        changed: pinned.changed,
        here: pinned.here,
        tipPeople: pinned.tipPeople,
        lane: pinned.lane,
        hasChanges: pinned.hasChanges,
        hasReview: pinned.hasReview,
        ...(pinned.draft ? { draft: true } : {}),
        teammate: pinned.teammate,
        openComments: pinned.openComments,
        reason: pinned.reason,
        autoPublish: pinned.autoPublish,
        ...(pinned.approved ? { approved: true } : {}),
        ...(pinned.propose ? { propose: pinned.propose } : {}),
        check: pinnedCheck(pinned),
        views: pinned.views,
      },
      true,
    );
  }
  for (const item of model.items) add(item, false);
  const sorted = byChange(entries);
  const byLane: Record<Lane, Entry[]> = { approve: [], publish: [], drafts: [], others: [], none: [] };
  for (const entry of liveFirst(sorted)) byLane[entry.lane].push(entry);
  const counts = { approve: 0, publish: 0, drafts: 0, others: 0 };
  for (const lane of LANES) counts[lane] = byLane[lane].length;
  return {
    pinned,
    entries: sorted,
    byLane,
    all: sorted.filter((entry) => entry.lane !== "none"),
    live: sorted.filter((entry) => entry.live && !entry.open),
    counts,
    empty: entries.length === 0,
  };
}

export function checkablesOf(layout: Layout, chip: StatusChipKey): Map<string, Checkable> {
  const out = new Map<string, Checkable>();
  const entries = chip === "all" ? layout.all : chip === "live" ? layout.live : layout.byLane[chip];
  const only = chip === "all" || chip === "live" ? undefined : KIND_OF_LANE[chip];
  for (const entry of entries) {
    const kind = entry.check;
    if (!kind || (only && kind !== only)) continue;
    const item = entry.item;
    out.set(item.id, {
      id: item.id,
      name: item.name,
      kind,
      documents: item.kind === "group" ? Math.max(1, item.members.length) : 1,
      isGroup: item.kind === "group",
      isDraft: item.kind === "doc" && (item.state === "draft" || item.state === "edited"),
      hasChanges: !!item.hasChanges,
      isOpen: entry.open,
    });
  }
  return out;
}

export interface Selection {
  checked: readonly Checkable[];
  documents: number;
  reviews: number;
  drafts: readonly Checkable[];
  groups: readonly Checkable[];
  discardable: readonly Checkable[];
  discardCount: number;
}

export function selectionOf(checkables: ReadonlyMap<string, Checkable>, checkedIds: ReadonlySet<string>): Selection {
  const checked = [...checkables.values()].filter((one) => checkedIds.has(one.id));
  const discardable = checked.filter((one) => one.kind !== "approve" && one.hasChanges);
  return {
    checked,
    documents: checked.reduce((sum, one) => sum + one.documents, 0),
    reviews: checked.length,
    drafts: checked.filter((one) => one.kind === "submit" && one.isDraft && !one.isGroup),
    groups: checked.filter((one) => one.kind === "submit" && one.isGroup),
    discardable,
    discardCount: discardable.reduce((sum, one) => sum + one.documents, 0),
  };
}

export const asksBeforeSubmit = (things: readonly Checkable[]): boolean => things.length > ASK_ABOVE;

export function pillRepeatsChip(chip: Lane, state: StatusDoc["state"], asksYou?: boolean): boolean {
  if (chip === "approve") return state === "in-review" && !!asksYou;
  if (chip === "publish") return state === "ready";
  if (chip === "drafts") return state === "draft";
  return false;
}

export function isSoleOpen(layout: Pick<Layout, "pinned" | "all" | "live">, folds?: readonly StatusFold[]): boolean {
  return (
    layout.pinned !== null &&
    layout.all.length === 1 &&
    layout.all[0]?.open === true &&
    layout.all[0].item.kind === "doc" &&
    layout.live.length === 0 &&
    (!folds || folds.length === 0)
  );
}

export const isDoc = (item: StatusItem): item is StatusDoc => item.kind === "doc";
export const isGroup = (item: StatusItem): item is StatusGroup => item.kind === "group";
