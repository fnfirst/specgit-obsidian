import type { FileKind } from "../mapping";

export const MARK_TIP = "specgit comment. Click to read it in the panel.";

export const TOOLBAR_OFFER = {
  offer: "Add Comment with specgit to your toolbar",
  added: "Added. You can move or remove it in Obsidian's toolbar settings.",
  notAdded: "Couldn't change the toolbar. You can add Comment with specgit in Obsidian's toolbar settings.",
  dismiss: "Not now",
} as const;

export const NOT_A_NOTE: Partial<Record<FileKind, string>> = {
  board: "Comments on a board are in specgit. Open it there to read and write them.",
  base: "Bases files don't have comments.",
};

export const COMMENT_BUTTON = {
  label: "Comment",
  select: "Select text in the note first.",
} as const;

export const NO_NOTE_OPEN = "Open a note to see its comments.";

export function commentEmptyWords(mobile: boolean): string {
  return mobile
    ? "Select text in the note, then press Comment."
    : "Select text in the note, then press Comment, or right-click it and choose Comment with specgit.";
}

export const PLUGIN_COMMENT_WORDS = {
  before: "Before",
  after: "After",
  commandName: "Comment with specgit",
  menuItem: "Comment with specgit",
  menuWordsChanged: "Those words changed while the menu was open. Select them again to comment.",
  notSavedYet: "This note is still saving. Try the comment again in a minute.",
  onlyHere: "That text is only in your vault so far. Click Connect Live in the Status tab, then comment on it.",
  unsent: {
    title: "Keep your unsent comment?",
    description: (quote: string): string => `You started a comment on “${quote.length > 60 ? `${quote.slice(0, 59).trimEnd()}…` : quote}” and haven't sent it.`,
    keep: "Keep writing",
    discard: "Discard it",
  },
  resolveAllInSpecgit: "Resolve all in specgit",
  notReachable: "Can't reach the live note, so your change isn't saved yet. Try again when you're back online.",
} as const;
