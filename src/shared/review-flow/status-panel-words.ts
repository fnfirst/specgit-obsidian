import { anonymousDisplayName } from "./dog-names";
import { BUSY_WORDS, openCommentsWarning, PUBLISH_ONLY_THIS, SUBMIT_ONLY_THIS } from "./lifecycle-copy";

export const STATUS_PILL_STATES = ["edited", "draft", "in-review", "changes-requested", "ready", "out-of-date", "held", "published", "changed-in-both", "deleted"] as const;
export type StatusPillState = (typeof STATUS_PILL_STATES)[number];

export const STATUS_PILL_WORDS: Record<StatusPillState, string> = {
  edited: "Edited",
  draft: "Draft",
  "in-review": "In review",
  "changes-requested": "Changes requested",
  ready: "Ready to publish",
  "out-of-date": "Out of date",
  held: "Held",
  published: "Published",
  "changed-in-both": "Changed in both",
  deleted: "Deleted",
};

export type StatusNoun = "document" | "note";

export const statusPlural = (noun: StatusNoun, count: number): string => (count === 1 ? noun : `${noun}s`);
const counted = (count: number, noun: StatusNoun): string => `${count} ${statusPlural(noun, count)}`;

export const STATUS_TITLE = "Status";

export type StatusListScope = { readonly kind: "repo"; readonly repo: string } | { readonly kind: "board" };

export const STATUS_ACTIVE_ON_BOARD = "Active on this board";

export function statusActiveInRepo(repo: string): string | null {
  if (typeof repo !== "string") return null;
  const raw = repo.trim();
  const trimmed = raw.replace(/\/+$/, "");
  if (raw.endsWith("/") && !trimmed.includes("/")) return null;
  const slash = trimmed.lastIndexOf("/");
  const short = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).trim();
  return short ? `Active in ${short}` : null;
}

export function statusScopeHeading(scope?: StatusListScope | null): string | null {
  if (!scope || typeof scope !== "object") return null;
  if (scope.kind === "board") return STATUS_ACTIVE_ON_BOARD;
  if (scope.kind === "repo") return statusActiveInRepo(scope.repo);
  return null;
}

export const STATUS_CHIPS = {
  all: "All",
  live: "Live",
  approve: "To approve",
  publish: "To publish",
  drafts: "Drafts",
  others: "With others",
} as const;
export const STATUS_CHIP_TIPS = {
  approve: "Reviews in this repository that ask you.",
  publish: "Your reviews ready to publish in this repository.",
  drafts: "Your unsubmitted changes in this repository.",
} as const;
export type StatusChipKey = "all" | "live" | "approve" | "publish" | "drafts";
type StatusStep = "submit" | "approve" | "publish";
const STEP_VERB: Record<StatusStep, string> = { submit: "submit", approve: "approve", publish: "publish" };
export const STATUS_OTHER_STEP = "One step at a time";
export const statusOtherStepLine = (row: StatusStep, chosen: StatusStep, checked: number): string =>
  `You checked ${checked === 1 ? "one" : checked} to ${STEP_VERB[chosen]}. To ${STEP_VERB[row]} this, uncheck ${checked === 1 ? "it" : "them"} first.`;
export const STATUS_NO_STEP = {
  teammate: { name: "Someone else's", line: (who: string, step: "submit" | "publish"): string => `Only ${who || "the person who wrote it"} can ${step} it.` },
  notInVault: { name: "Not in this vault", line: "Open the ⋯ menu and choose Bring into this vault to submit it here." },
  propose: { name: "Propose instead", line: (repo: string): string => `Propose this to ${repo} from the card above.` },
  inReview: { name: "In review", line: "You can publish it once it's approved." },
  changesRequested: { name: "Changes requested", line: "Update it before publishing." },
  outOfDate: { name: "Catch up first", line: "The published version changed." },
  changedInBoth: { name: "Choose what to keep first", line: "It changed here and on GitHub." },
  deleted: { name: "Deleted", line: "There's nothing to submit or publish." },
  published: { name: "Published", line: "There are no unpublished changes to send." },
  nothingToSend: { name: "No step right now", line: "There's nothing to submit or publish here." },
} as const;

export const statusHere = (logins: readonly string[]): string => `${statusWho(logins)} ${logins.length > 1 ? "are" : "is"} here`;

export const STATUS_CARD = {
  connect: "Connect Live",
  connecting: "Connecting…",
  disconnect: "Disconnect",
  workOffline: "Work offline",
  resumeSync: "Resume sync",
  openInSpecgit: "Open in specgit",
  copyLink: "Copy link",
  viewOnGitHub: "View on GitHub",
} as const;

export const statusPeopleHere = (count: number): string => `${count} ${count === 1 ? "person" : "people"} here`;

export const statusFoldRow = (heading: string, count: number): string => `${heading} · ${count}`;
export const STATUS_FOLDS = {
  notHere: { label: "Not in this vault", button: "Copy in" },
  newer: { label: "Newer on GitHub", button: "Bring in" },
  deleted: { label: "Deleted on GitHub", button: "Move to trash" },
  offered: { label: "Changes you can add", button: "Add" },
} as const;
export const statusFoldProgress = (done: number, total: number): string => `Copying ${done} of ${total}…`;
export const statusShowMore = (count: number): string => `Show ${count} more`;
export const statusGroupCount = (count: number, noun: StatusNoun): string => counted(count, noun);

export const statusWho = (people: readonly string[], asksYou = false): string => {
  const shown = people.map(anonymousDisplayName);
  const list = shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return asksYou ? `${list} asked you` : list;
};

export const statusLiveWho = (logins: readonly string[]): string => {
  const shown = logins.map(anonymousDisplayName);
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown[0]} +${shown.length - 1}`;
};

export const STATUS_ROW_BUTTONS = {
  join: "Join",
  review: "Review",
  publish: "Publish…",
  choose: "Choose what to keep…",
  "catch-up": "Catch up",
  open: "Open",
} as const;
export type StatusRowButton = keyof typeof STATUS_ROW_BUTTONS;

export const STATUS_ROW_MENU = {
  open: "Open",
  "show-changes": "Show changes",
  "see-github": "See GitHub's changes",
  "see-difference": "See how it differs from GitHub",
  "submit-only": SUBMIT_ONLY_THIS,
  "publish-only": PUBLISH_ONLY_THIS,
  "add-reviewer": "Add reviewer…",
  "move-back": "Move back to draft",
  "stop-review": "Stop the review…",
  discard: "Discard my changes…",
  "view-on-github": "View on GitHub",
  "bring-in": "Bring into this vault",
} as const;
export type StatusRowMenuItem = keyof typeof STATUS_ROW_MENU;

export const STATUS_GROUP_MENU = {
  rename: "Rename",
  ungroup: "Ungroup",
  "submit-only": SUBMIT_ONLY_THIS,
  "publish-only": PUBLISH_ONLY_THIS,
  "add-reviewer": "Add reviewer…",
  "move-back": "Move back to draft",
  "stop-review": "Stop the review…",
  "view-on-github": "View on GitHub",
} as const;
export type StatusGroupMenuItem = keyof typeof STATUS_GROUP_MENU;
export const STATUS_GROUP_BUTTONS = { choose: "Choose what to keep…" } as const;

export const STATUS_REASON_MAX = 60;
export const statusClipReason = (reason: string): string => (reason.length <= STATUS_REASON_MAX ? reason : `${reason.slice(0, STATUS_REASON_MAX - 1).trimEnd()}…`);

export const STATUS_SELECT_ALL = "Select all";
export const STATUS_BAR = {
  group: "Group together",
  addTo: (count: number, name: string): string => `Add ${count} to ${name}`,
  addToMenu: (count: number): string => `Add ${count} to…`,
  newGroup: "New group",
  groupReason: (noun: StatusNoun): string => `Check two ${statusPlural(noun, 2)} that are drafts to group them.`,
  groupCount: (count: number): string => `Group ${count} together`,
} as const;

export const statusSubmitLabel = (count: number, openOne: boolean, noun: StatusNoun): string => (count === 1 && openOne ? `Submit this ${noun}…` : `Submit ${counted(count, noun)}…`);
export const statusPublishLabel = (count: number, openOne: boolean, noun: StatusNoun): string => (count === 1 && openOne ? "Publish…" : `Publish ${counted(count, noun)}…`);
export const statusApproveLabel = (count: number, openOne: boolean, noun: StatusNoun): string => (count === 1 && openOne ? "Approve" : `Approve ${counted(count, noun)}…`);
export const statusProposeLabel = (upstream: string): string => `Propose to ${upstream}`;
export type StatusRunning = "submit" | "approve" | "publish" | "propose";
export const STATUS_RUNNING: Record<StatusRunning, string> = { submit: BUSY_WORDS.submit, approve: BUSY_WORDS.approve, publish: BUSY_WORDS.publish, propose: "Proposing…" };
export const STATUS_VIEW_ONLY = "View only";
export const statusDiscard = (count: number, noun: StatusNoun): string => `Discard changes to ${counted(count, noun)}…`;

export const STATUS_SEPARATE = {
  title: (count: number): string => `Submit ${count} separate reviews?`,
  group: "Group them",
  submit: (count: number): string => `Submit ${count}`,
} as const;

export const STATUS_SUBMIT_STEP = {
  title: (count: number, noun: StatusNoun): string => `Submit ${counted(count, noun)}`,
  reviewers: "Reviewers",
  add: "+ Add",
  remove: (login: string): string => `Don't ask ${login}`,
  back: "Back",
  submit: "Submit",
} as const;
export const statusOpenComments = (comments: number, documents: number, noun: StatusNoun): string | null =>
  comments === 0 ? null : documents === 1 ? openCommentsWarning(comments, noun) : `${comments} open ${comments === 1 ? "comment" : "comments"} on these ${statusPlural(noun, 2)}.`;

export const STATUS_PINNED = {
  showChanges: "Show changes",
  add: "+ Add",
  catchUp: "Catch up",
  askChanges: "Ask for changes…",
  choose: "Choose what to keep…",
} as const;
export const STATUS_REVIEWER_MARK = { approved: "approved", changes: "asked for changes", asked: "asked" } as const;

export const STATUS_EMPTY = "Everything is published.";
export const STATUS_FAILED = "Couldn't load.";
export const STATUS_RETRY = "Try again";
export const STATUS_OFFLINE = "Offline. Your changes are kept.";
export const STATUS_SLOW = "Still waiting for GitHub. It's slower than usual.";
export const STATUS_RATE_LIMITED = "GitHub asked specgit to slow down. Status will refresh in a moment.";
export const statusRateLimited = (retryAfterMs?: number | null): string => {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 60_000) return STATUS_RATE_LIMITED;
  const mins = Math.max(1, Math.round(retryAfterMs / 60_000));
  return `GitHub asked specgit to slow down. Status will refresh in about ${mins} min.`;
};

export const statusBulkResult = (done: number, did: "published" | "submitted" | "approved", needs: number): string =>
  needs === 0 ? `${done} ${did}.` : `${done} ${did}. ${needs} ${needs === 1 ? "needs" : "need"} you.`;

export const STATUS_LABELS = {
  select: (name: string): string => `Select ${name}`,
  selectAll: "Select all",
  more: (name: string): string => `More for ${name}`,
  close: "Close",
  files: (name: string): string => `Documents in ${name}`,
  showChanges: "Show changes",
} as const;

const peopleList = (logins: readonly string[]): string => statusWho(logins);
export const STATUS_TIPS = {
  edited: "Changed here only.",
  draft: "Not submitted yet.",
  inReview: (logins: readonly string[]): string => `Waiting for ${peopleList(logins)}.`,
  changesRequested: (logins: readonly string[]): string => `${peopleList(logins)} asked for changes.`,
  ready: "Approved. Publish when you like.",
  readyUnblocked: "Nothing blocks publishing. Publish when you like.",
  outOfDate: "The published version changed.",
  waitingForYou: (logins: readonly string[]): string => `${peopleList(logins)} ${logins.length > 1 ? "are" : "is"} waiting for you.`,
  live: (count: number): string => (count > 1 ? "Are in it now." : "Is in it now."),
  worked: "Has worked on it.",
  asked: "Asked you.",
  wasNamed: (before: string): string => `Was ${before}.`,
  join: "Open it and write with them.",
  groupTogether: (noun: StatusNoun): string => `One review for the checked ${statusPlural(noun, 2)}.`,
  showChanges: "Highlights what's new since it was published.",
  autoPublish: "Publishes by itself once it's approved.",
} as const;

export const STATUS_CONTROL_TIPS = {
  statusTab: { name: "Status", line: "Where your edits are saved, and where the review stands." },
  commentsTab: { name: "Comments", line: "Talk about the text, one thread at a time." },
  all: { name: "All", line: "Everything in this list, yours and your teammates'." },
  select: { name: "Select", line: "Check notes to act on them together." },
  more: { name: "More", line: "Other things you can do with this note." },
  workOffline: { name: "Work offline", line: "Pause live editing and auto-sync for this note only. Your other notes stay connected." },
  resumeSync: { name: "Resume sync", line: "Reconnect this note and merge any changes with GitHub." },
} as const;

export { SAVER_PAUSED_LABEL, saverWaitingLine, type SaverReason, type SaverStatus, type SaverWaiting } from "./saver-words";
