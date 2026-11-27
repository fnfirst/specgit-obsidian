import {
  draftWorkItems,
  groupEntry,
  groupHeld,
  groupWriters,
  heldKind,
  heldWords,
  inFlightEntries,
  isSomeoneElses,
  openedBy,
  reviewStage,
  sameLogin,
  timeAgo,
  unitKey,
  waitsOnViewer,
  withReviewFacts,
  type ChangeSetEntry,
  type GroupOverview,
  type InFlightBranch,
  type InFlightResponse,
  type PrMergeableState,
  type PrReviewDecision,
} from "../review-flow";
import type { CheckKind, Lane, StatusDoc, StatusGroup, StatusItem, StatusPerson, StatusPillState, StatusReviewer } from "./types";

export interface ReviewFacts {
  isDraft: boolean;
  state: "open" | "closed" | "merged";
  mergeableState: PrMergeableState | null;
  behind?: boolean;
  reviewDecision: PrReviewDecision | null;
  requestedReviewers: readonly string[];
  authorLogin: string | null;
  autoMergeEnabled?: boolean;
  reviewers: readonly { login: string; avatarUrl?: string; state: "requested" | "approved" | "changes_requested" }[];
}

export interface ReviewDetail {
  isDraft?: boolean;
  state?: string;
  merged?: boolean;
  mergeableState?: PrMergeableState | null;
  behind?: boolean;
  reviewPolicy?: { reviewDecision?: PrReviewDecision | null } | null;
  requestedReviewers?: readonly string[] | null;
  authorLogin?: string | null;
  autoMergeEnabled?: boolean;
  reviewers?: readonly { login: string; avatarUrl?: string | null; state: "requested" | "approved" | "changes_requested" }[] | null;
}

export function factsFromDetail(detail: ReviewDetail): ReviewFacts {
  const reviewers = detail.reviewers ?? [];
  return {
    isDraft: detail.isDraft === true || detail.state === "draft",
    state: detail.merged || detail.state === "merged" ? "merged" : detail.state === "closed" ? "closed" : "open",
    mergeableState: detail.mergeableState ?? null,
    behind: detail.behind === true,
    reviewDecision: detail.reviewPolicy?.reviewDecision ?? null,
    requestedReviewers: [...(detail.requestedReviewers ?? reviewers.filter((one) => one.state === "requested").map((one) => one.login))],
    authorLogin: detail.authorLogin ?? null,
    ...(detail.autoMergeEnabled === undefined ? {} : { autoMergeEnabled: detail.autoMergeEnabled }),
    reviewers: reviewers.map((one) => ({ login: one.login, ...(one.avatarUrl ? { avatarUrl: one.avatarUrl } : {}), state: one.state })),
  };
}

export interface PillInput {
  deleted?: boolean;
  edited?: boolean;
  changedInBoth?: boolean;
  held?: string | null;
  behind?: boolean;
  facts?: ReviewFacts | null;
  without?: "draft" | "in-review" | "published";
}

export function pillOf(input: PillInput): StatusPillState {
  const facts = input.facts ?? null;
  if (input.deleted) return "deleted";
  if (input.changedInBoth || facts?.mergeableState === "dirty") return "changed-in-both";
  if (input.held != null) return "held";
  if (input.edited) return "edited";
  if (facts?.behind || input.behind) return "out-of-date";
  if (!facts || facts.state === "closed") return input.without ?? "draft";
  if (facts.state === "merged") return "published";
  if (facts.isDraft) return "draft";
  if (facts.reviewDecision === "changes_requested") return "changes-requested";
  const stage = reviewStage({ isDraft: false, mergeableState: facts.mergeableState, autoMergeEnabled: facts.autoMergeEnabled });
  return stage === "in_review" && facts.requestedReviewers.length === 0 ? "ready" : "in-review";
}

const basename = (path: string): string => path.split("/").pop() ?? path;
const titleOf = (path: string): string => basename(path).replace(/\.[^./]+$/, "");

export function asksYouOf(entry: ChangeSetEntry, facts: ReviewFacts | null | undefined, viewer: string): boolean {
  if (!facts || facts.state !== "open" || facts.isDraft) return false;
  const author = entry.authorLogin ?? facts.authorLogin;
  if (author !== null && sameLogin(author, viewer)) return false;
  if (facts.requestedReviewers.some((login) => sameLogin(login, viewer))) return true;
  if (facts.requestedReviewers.length > 0) return false;
  return waitsOnViewer(withReviewFacts(entry, facts), viewer);
}

const asYou = (login: string, viewer: string): string => (sameLogin(login, viewer) ? "you" : login);
const asYous = (logins: readonly string[], viewer: string): string[] => logins.map((login) => asYou(login, viewer));
const withoutViewer = (people: readonly StatusPerson[] | undefined, viewer: string): StatusPerson[] => (people ?? []).filter((one) => !sameLogin(one.login, viewer));

export interface DocExtra {
  deleted?: boolean;
  edited?: boolean;
  changedInBoth?: boolean;
  held?: string | null;
  behind?: boolean;
  renamedFrom?: string;
  hasChanges?: boolean;
  bringIn?: boolean;
  reason?: string;
  folder?: string;
  changed?: number;
}

export interface DocItemInput {
  entry: ChangeSetEntry;
  branch?: InFlightBranch | null;
  facts?: ReviewFacts | null;
  here?: readonly StatusPerson[];
  viewer: string;
  now: number;
  extra?: DocExtra;
}

export function docItemOf({ entry, branch = null, facts = null, here, viewer, now, extra = {} }: DocItemInput): StatusDoc {
  const known = facts ?? null;
  const enriched = known ? withReviewFacts(entry, known) : entry;
  const asksYou = asksYouOf(entry, known, viewer);
  const teammate = isSomeoneElses(enriched, viewer) && !asksYou;
  const without = entry.prNumber > 0 && !entry.isDraft ? "in-review" : "draft";
  const state = pillOf({ deleted: extra.deleted, edited: extra.edited, changedInBoth: extra.changedInBoth, held: extra.held, behind: extra.behind, facts: known, without });
  const author = enriched.authorLogin;
  const writers = branch?.writers && branch.writers.length > 0 ? branch.writers : author ? [author] : [];
  const people = asksYou && author ? [author] : writers;
  const check: CheckKind | undefined = teammate
    ? undefined
    : asksYou
      ? "approve"
      : state === "draft" || state === "edited" || (state === "held" && entry.prNumber <= 0)
        ? "submit"
        : state === "ready" || state === "deleted"
          ? "publish"
          : undefined;
  const tipPeople =
    asksYou && author
      ? [author]
      : state === "in-review"
        ? [...(known?.requestedReviewers ?? entry.requestedReviewers)]
        : state === "changes-requested"
          ? (known?.reviewers ?? []).filter((one) => one.state === "changes_requested").map((one) => one.login)
          : undefined;
  const ownedByViewer = viewer !== "" && enriched.authorLogin !== null && sameLogin(enriched.authorLogin, viewer);
  const lane: Lane | undefined =
    known === null && ownedByViewer && !teammate && !asksYou && state === "in-review" && entry.prNumber > 0 && !entry.isDraft && entry.requestedReviewers.length === 0 ? "publish" : undefined;
  const lastCommitAt = branch?.lastCommitAt;
  const changed = lastCommitAt ? Date.parse(lastCommitAt) : extra.changed;
  return {
    kind: "doc",
    id: entry.path,
    name: titleOf(entry.path),
    ...(extra.renamedFrom ? { renamedFrom: extra.renamedFrom } : {}),
    state,
    ...(lastCommitAt ? { when: timeAgo(lastCommitAt, now) } : {}),
    ...(changed !== undefined && changed > 0 ? { changed } : {}),
    people: asYous(people, viewer),
    asksYou,
    here: withoutViewer(here, viewer),
    teammate,
    ...(lane ? { lane } : {}),
    ...(check ? { check } : {}),
    ...(state === "out-of-date" ? { button: "catch-up" as const } : state === "changed-in-both" ? { button: "choose" as const } : {}),
    hasReview: entry.prNumber > 0,
    ...((known ? known.isDraft : entry.isDraft) ? { draft: true } : {}),
    ...(known?.autoMergeEnabled === true ? { autoPublish: true } : {}),
    ...(known?.reviewDecision === "approved" ? { approved: true } : {}),
    ...(extra.hasChanges ? { hasChanges: true } : {}),
    ...(extra.bringIn ? { bringIn: true } : {}),
    ...(tipPeople ? { tipPeople } : {}),
    ...(extra.reason ? { reason: extra.reason } : state === "held" && extra.held ? { reason: extra.held } : {}),
    ...(extra.folder ? { folder: extra.folder } : {}),
  };
}

export interface GroupItemInput {
  overview: GroupOverview;
  entries: readonly InFlightBranch[];
  facts?: ReviewFacts | null;
  rooms?: ReadonlyMap<string, readonly StatusPerson[]>;
  viewer: string;
  now: number;
  editing?: boolean;
}

export function groupItemOf({ overview, entries, facts = null, rooms, viewer, now, editing }: GroupItemInput): StatusGroup {
  const unit = groupEntry(overview);
  const overviewAuthor = overview.authorLogin && overview.authorLogin !== "" ? overview.authorLogin : null;
  const entryAuthors = entries.flatMap((one) => [openedBy(one), one.prAuthorLogin ?? null]).filter((login): login is string => login !== null && login !== "");
  const fallbackAuthor = overviewAuthor ?? entryAuthors[0] ?? null;
  const own: ReviewFacts = { isDraft: overview.isDraft, state: "open", mergeableState: overview.mergeableState, reviewDecision: null, requestedReviewers: [], authorLogin: fallbackAuthor, reviewers: [] };
  const awaitingFacts = facts === null && overview.prNumber > 0 && !overview.isDraft;
  const merged: ReviewFacts | null = facts
    ? { ...facts, authorLogin: facts.authorLogin ?? fallbackAuthor, mergeableState: overview.mergeableState }
    : awaitingFacts
      ? null
      : own;
  const held = groupHeld(overview);
  const behind = overview.hold === "behind" && !overview.ending;
  const without = overview.prNumber > 0 && !overview.isDraft ? "in-review" : "draft";
  const state = pillOf({ changedInBoth: overview.mergeableState === "dirty", held: held && !behind ? held.words : null, behind, facts: merged, without });
  const asksYou = asksYouOf(unit, merged, viewer);
  const writers = groupWriters(entries);
  const owners = [merged?.authorLogin ?? null, overviewAuthor, ...entryAuthors, ...writers].filter((login): login is string => login !== null && login !== "");
  const teammate = viewer !== "" && !asksYou && owners.length > 0 && !owners.some((login) => sameLogin(login, viewer));
  const lastCommitAt = [...entries].map((one) => one.lastCommitAt).sort().at(-1);
  const people = asksYou && merged?.authorLogin ? [merged.authorLogin] : writers;
  const here = new Map<string, StatusPerson>();
  for (const path of overview.paths) for (const one of rooms?.get(path) ?? []) if (!here.has(one.login.toLowerCase())) here.set(one.login.toLowerCase(), one);
  const check: CheckKind | undefined = teammate ? undefined : asksYou ? "approve" : state === "draft" ? "submit" : state === "ready" ? "publish" : undefined;
  const ownedByViewer = viewer !== "" && owners.some((login) => sameLogin(login, viewer));
  const lane: Lane | undefined = awaitingFacts && ownedByViewer && !teammate && !asksYou && state === "in-review" ? "publish" : undefined;
  const words = heldWords(overview);
  return {
    kind: "group",
    id: unitKey(unit),
    name: overview.name,
    members: overview.paths.map((path) => ({ id: path, name: titleOf(path) })),
    state,
    ...(lastCommitAt ? { when: timeAgo(lastCommitAt, now), changed: Date.parse(lastCommitAt) } : {}),
    ...(words ? { reason: words } : {}),
    ...(heldKind(overview.hold) || overview.ending ? { button: "choose" as const } : {}),
    ...(overview.ending ? { ending: true } : {}),
    people: asYous(people, viewer),
    asksYou,
    ...(teammate ? { teammate: true } : {}),
    ...(lane ? { lane } : {}),
    ...(check ? { check } : {}),
    ...(editing ? { editing: true } : {}),
    hasReview: overview.prNumber > 0,
    ...((facts ? facts.isDraft : overview.isDraft) ? { draft: true } : {}),
    ...(facts?.autoMergeEnabled === true ? { autoPublish: true } : {}),
    ...(facts?.reviewDecision === "approved" ? { approved: true } : {}),
    here: withoutViewer([...here.values()], viewer),
    ...(asksYou && merged?.authorLogin ? { tipPeople: [merged.authorLogin] } : state === "in-review" ? { tipPeople: [...(merged?.requestedReviewers ?? [])] } : state === "changes-requested" ? { tipPeople: (merged?.reviewers ?? []).filter((one) => one.state === "changes_requested").map((one) => one.login) } : {}),
  };
}

export interface ItemsInput {
  inFlight: InFlightResponse;
  facts: ReadonlyMap<number, ReviewFacts>;
  rooms: ReadonlyMap<string, readonly StatusPerson[]>;
  viewer: string;
  now: number;
  exclude?: ReadonlySet<string>;
  holdOf?: (path: string) => string | null;
}

export function itemsFromInFlight({ inFlight, facts, rooms, viewer, now, exclude, holdOf }: ItemsInput): StatusItem[] {
  const skip = exclude ?? new Set<string>();
  const entries = inFlightEntries(inFlight, viewer, inFlight.base);
  const branches = new Map<string, InFlightBranch>();
  for (const { path, entry } of draftWorkItems(inFlight.paths, viewer, inFlight.base)) if (!branches.has(path)) branches.set(path, entry);
  const overviews = Object.entries(inFlight.groups ?? {}).filter(([, overview]) => overview.paths.length > 0 || overview.prNumber > 0);
  const grouped = new Set(overviews.flatMap(([, overview]) => overview.paths));
  const items: StatusItem[] = [];
  const listed = new Set<string>();
  for (const entry of entries) {
    if (grouped.has(entry.path) || skip.has(entry.path)) continue;
    listed.add(entry.path);
    const held = holdOf?.(entry.path) ?? null;
    items.push(docItemOf({ entry, branch: branches.get(entry.path), facts: entry.prNumber > 0 ? facts.get(entry.prNumber) : null, here: rooms.get(entry.path), viewer, now, ...(held !== null ? { extra: { held } } : {}) }));
  }
  for (const [branch, overview] of overviews) {
    const own = overview.paths.flatMap((path) => (inFlight.paths[path] ?? []).filter((one) => one.branch === branch).slice(0, 1));
    items.push(groupItemOf({ overview, entries: own, facts: facts.get(overview.prNumber), rooms, viewer, now }));
  }
  for (const [path, people] of rooms) {
    if (listed.has(path) || grouped.has(path) || skip.has(path)) continue;
    const here = withoutViewer(people, viewer);
    if (here.length === 0) continue;
    items.push({ kind: "doc", id: path, name: titleOf(path), people: here.map((one) => one.login), here });
  }
  return items;
}

export function reviewerChips(facts: Pick<ReviewFacts, "reviewers">): StatusReviewer[] {
  return facts.reviewers.map((one) => ({ login: one.login, ...(one.avatarUrl ? { avatarUrl: one.avatarUrl } : {}), ...(one.state === "approved" ? { mark: "approved" as const } : one.state === "changes_requested" ? { mark: "changes" as const } : {}) }));
}
