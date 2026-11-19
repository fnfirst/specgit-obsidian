export const noticeText = (title: string, description?: string | null): string => (description ? `${title.replace(/[.!?…]+$/, "")}. ${description}` : title);

export const STOP_REVIEW = {
  title: (name: string): string => `Stop the review of ${name}?`,
  titleMany: (count: number): string => `Stop ${count} reviews?`,

  points: [
    { icon: "git-pull-request-closed", text: "The review on GitHub will be closed" },
    { icon: "file-check", text: "Your note stays exactly as it is, so you can submit it again later" },
  ],
  pointsMany: [
    { icon: "git-pull-request-closed", text: "The reviews on GitHub will be closed" },
    { icon: "file-check", text: "Your notes stay exactly as they are, so you can submit them again later" },
  ],
  confirm: "Stop the review",
  confirmMany: (count: number): string => `Stop ${count} reviews`,
  done: { title: "Review stopped", description: "Your note is unchanged." },
  failed: "Couldn't stop the review",

  moved: {
    title: "Nothing was stopped",
    one: (name: string): string => `The review of ${name} has changed since specgit last checked. Try again in a moment.`,
    many: "Some of these reviews have changed since specgit last checked. Try again in a moment.",
  },

  needsGitHub: "specgit couldn't load the version in GitHub, which it needs to keep your note unchanged. Try again in a moment.",

  item: "Stop the review…",
  busy: "Stopping…",
} as const;

export const PUBLISHED_HERE = { title: "Published", description: "Your changes are in the version everyone sees." } as const;
export const AUTO_PUBLISH_HERE = { title: "Automatic publish is on", description: "This note is published the moment it's approved. Nothing else to do." } as const;
export const REVIEW_REQUESTED_HERE = (login: string): { title: string; description: string } => ({ title: "Review requested", description: `${login} was asked to review this note.` });

export const ADD_REVIEWER_HERE = "They'll get a GitHub notification with a link that opens this note in specgit.";

export function partialReview(asked: readonly string[], refused: readonly string[]): { title: string; description: string } {
  const who = refused.join(", ");
  return {
    title: "Sent for review, with one problem",
    description: `${asked.length ? `${asked.join(", ")} ${asked.length === 1 ? "was" : "were"} asked. ` : ""}GitHub couldn't add ${who}: check the username${refused.length === 1 ? "" : "s"}.`,
  };
}

export const DELETE_CONFIRM = {
  title: (name: string, repo: string): string => `Delete ${name} from ${repo}?`,
  titleMany: (count: number, repo: string): string => `Delete ${count} files from ${repo}?`,
  points: [
    { icon: "trash-2", text: "This note will be deleted from GitHub for everyone" },
    { icon: "git-pull-request-closed", text: "Its review will be closed, and files only this note used will be deleted too" },
    { icon: "history", text: "GitHub keeps its history" },
  ],
  pointsMany: [
    { icon: "trash-2", text: "These notes will be deleted from GitHub for everyone" },
    { icon: "git-pull-request-closed", text: "Their reviews will be closed, and files only these notes used will be deleted too" },
    { icon: "history", text: "GitHub keeps their history" },
  ],
  confirm: "Delete",
} as const;

export const readOnlyRepo = (repo: string): string => `You can read ${repo} but not change it. Ask an owner for write access.`;

export const writesOffWords = (offline: boolean, readOnly: boolean, repo: string): string | null => (offline ? OFFLINE_WHY : readOnly ? readOnlyRepo(repo) : null);

export const CATCH_UP_HERE = {
  title: "The published version changed",
  body: (name: string): string => `Changes to ${name} were published after you started. Catch up to bring them in.`,

  lookAgain: "Reviewers may be asked to look again.",
  places: (count: number): string => `You both changed ${count === 1 ? "1 place" : `${count} places`}.`,
  button: "Catch up",
  busy: "Catching up…",
  done: { title: "Caught up", description: "Your note now has the published changes." },

  doneInReview: { title: "Caught up", description: "The published changes were added to your review. They'll show up in your note the next time it saves, and what you just typed is safe." },
  failed: "Couldn't catch up",

  leftAsWas: { title: "Your note wasn't changed", description: "You edited it while specgit was catching up. Click Catch up again." },
} as const;

export const MERGED_REVIEW = {
  title: "Review the merged note",
  intro: "The published changes fit into your note. The new parts are marked. Click Apply to save.",
  before: "Before",
  after: "Merged",
} as const;

export type ChangesContext =
  | { kind: "yours"; name: string }

  | { kind: "mine"; name: string; what: string }
  | { kind: "came-in" }
  | { kind: "from-github" }
  | { kind: "github"; name: string; what: string }

  | { kind: "difference"; name: string; what: string };

export const CHANGES_VIEW = {
  yours: {
    title: (name: string): string => `Your changes to ${name}`,
    intro: "What you changed, compared with the published version. None of it is published yet.",
    before: "Published",
    after: "Yours",
    beforeEmpty: "Nothing here in the published version",
    afterEmpty: "Nothing here in your note",
  },

  mine: {
    title: (name: string): string => `Your changes to ${name}`,
    intro: (what: string): string => `What you changed since your ${what} last matched GitHub.`,
    before: "When it last matched",
    after: "Yours",
    beforeEmpty: "Nothing here when it last matched",
    afterEmpty: (what: string): string => `Nothing here in your ${what}`,
  },

  github: {
    title: (name: string): string => `GitHub's changes to ${name}`,
    intro: (what: string): string => `What changed on GitHub since your ${what} last matched it.`,
    before: "When it last matched",
    after: "On GitHub now",
    beforeEmpty: "Nothing here when it last matched",
    afterEmpty: "Nothing here on GitHub",
  },

  difference: {
    title: (name: string): string => `How ${name} differs from GitHub`,
    intro: (what: string): string => `specgit can't tell who changed these parts, so it shows your ${what} next to the version in GitHub.`,
    before: (what: string): string => `Your ${what}`,
    after: "On GitHub now",
    beforeEmpty: (what: string): string => `Nothing here in your ${what}`,
    afterEmpty: "Nothing here on GitHub",
  },
  cameIn: {
    title: "Changes that came in",
    intro: "These changes were added to your note when it connected live. They are in your note now.",
    before: "Before",
    after: "Now",
    beforeEmpty: "Nothing here before",
    afterEmpty: "Nothing here now",
  },
  fromGithub: {
    title: "Changes that came in from GitHub",
    intro: "These changes came in from GitHub. They are in your notes now.",
    before: "Before",
    after: "Now",
    beforeEmpty: "Nothing here before",
    afterEmpty: "Nothing here now",
  },
  none: "Nothing differs from the published version.",
  couldNotRead: "Couldn't read the published version just now. Try again in a moment.",
  menu: "Show changes",
} as const;

export const githubSame = (what: string): string => `Nothing has changed on GitHub since your ${what} last matched it.`;
export const mineSame = (what: string): string => `You haven't changed your ${what} since it last matched GitHub.`;

export const sameAsGitHub = (what: string): string => `Your ${what} is the same as the version in GitHub.`;
export const GITHUB_GONE = "GitHub no longer has this file.";
export const GONE_FROM_VAULT = "This file is no longer in your vault.";
export const GITHUB_UNREADABLE = "Couldn't load the version in GitHub just now. Try again in a moment.";

export interface ChangesWords {
  title: string;
  intro: string;
  before: string;
  after: string;
  beforeEmpty: string;
  afterEmpty: string;
}

export function changesWords(context: ChangesContext): ChangesWords {
  switch (context.kind) {
    case "yours": {
      const { yours } = CHANGES_VIEW;
      return { title: yours.title(context.name), intro: yours.intro, before: yours.before, after: yours.after, beforeEmpty: yours.beforeEmpty, afterEmpty: yours.afterEmpty };
    }
    case "mine": {
      const { mine } = CHANGES_VIEW;
      return { title: mine.title(context.name), intro: mine.intro(context.what), before: mine.before, after: mine.after, beforeEmpty: mine.beforeEmpty, afterEmpty: mine.afterEmpty(context.what) };
    }
    case "came-in":
      return { ...CHANGES_VIEW.cameIn };
    case "from-github":
      return { ...CHANGES_VIEW.fromGithub };
    case "github": {
      const { github } = CHANGES_VIEW;
      return { title: github.title(context.name), intro: github.intro(context.what), before: github.before, after: github.after, beforeEmpty: github.beforeEmpty, afterEmpty: github.afterEmpty };
    }
    case "difference": {
      const { difference } = CHANGES_VIEW;
      return { title: difference.title(context.name), intro: difference.intro(context.what), before: difference.before(context.what), after: difference.after, beforeEmpty: difference.beforeEmpty(context.what), afterEmpty: difference.afterEmpty };
    }
  }
}

export type NotLiveWhy = "read-only" | "revoked" | "unreachable" | "deleted";

export const NOT_LIVE = {
  readOnly: (repo: string): string => `You can read ${repo} but not change it, so your edits stay in this vault. Ask an owner of the repository for write access.`,
  revoked: "specgit's sign-in to GitHub has stopped working. Sign in again to fix it.",
  unreachable: "specgit can't connect to the live note right now. Your edits stay in this vault.",

  retryIn: (seconds: number): string => `Trying again in ${seconds} s.`,
  trying: "Trying to connect…",
  tryNow: "Try now",
  signIn: "Sign in",

  deleted: "This note was deleted on specgit.com.",
} as const;

export const OFFLINE_WHY = "specgit can't be reached.";

export const OFFLINE_LIST = "This list updates when you're back online.";

export const DELETE_HELD_BACK = "not deleted, because an earlier file in this set failed. Nothing was removed.";
