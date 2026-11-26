export const STAY = {
  name: "Stay connected",
  what: "Saves your edits for review as you go, and brings in other people's.",
  whileOpen: "It works while Obsidian is open, and catches up when you come back.",
  on: "On",
  off: "Off",
  standing: (on: boolean): string => (on ? "On for this vault." : "Off. Your edits stay on this device."),
} as const;

export const OFFER = {
  title: "Stay connected?",
  description: (repo: string): string => `Saves your edits to ${repo} for review as you go, and brings in other people's. Nothing is published until you click Publish.`,
  confirm: "Turn on",
  cancel: "Not now",
} as const;

export const CHOICE_WORDS = {
  draft: "This note and its unpublished changes both changed it.",
  main: "This note and GitHub both changed it.",
  review: "This note is in review, and GitHub changed it too.",
  choose: "Choose what to keep",
  catchUp: "Catch up",
  show: "Show it",
} as const;

export const DRAFT_SAID = {
  conflict: (name: string): string => `${name} was changed here and somewhere else, in the same place. Nothing was overwritten.`,
  notApplied: (name: string): string => `${name} changed while you were choosing, so nothing was overwritten. Try again.`,
  discarded: (name: string): string => `The unpublished changes to ${name} were dropped, so it shows the published version again.`,
  offer: (by: string, name: string): string => `${by} has unpublished changes to ${name}.`,
  offerButton: "Add to my note",
  offerTogether: (count: number): string => `${count === 1 ? "1 note has" : `${count} notes have`} changes you can add.`,
  offerTogetherButton: "Show them",
  offerTogetherPlain: (count: number): string => `Other people have unpublished changes to ${count} ${count === 1 ? "note" : "notes"}.`,
  offerTogetherPlainButton: "Add them to my notes",
  renameKept: (name: string, newName: string): string => `${name} was renamed to ${newName} elsewhere, and you changed it here. Both are in Changes.`,
  away: (count: number): string => `specgit added changes to ${count === 1 ? "1 note" : `${count} notes`} while this window was hidden.`,
  theirsDraft: (by: string, name: string): string => `${by} has unpublished changes to ${name}.`,
  theirsInReview: (by: string): string => `${by} has this file in review. It may publish soon.`,
  chooseButton: "Choose what to keep",
  closedElsewhere: (names: readonly string[], byWhom: "someone else" | "unknown" = "someone else"): string => {
    const by = byWhom === "someone else" ? " by someone else" : "";
    return names.length === 1
      ? `The review of ${names[0]} was closed on GitHub${by}. Your note keeps the changes.`
      : `${names.length} reviews were closed on GitHub${by}. Your notes keep the changes.`;
  },
  closedElsewhereButton: "Show them",
  deletedKept: (name: string): string => `${name} was deleted on GitHub. Your note keeps your changes. Submit it to bring it back.`,
} as const;

export const STAY_HELD = {
  closed: "Changed while Obsidian was closed. Not saved yet.",
  stopped: "Review stopped. Edit the note to save it again.",
  ended: "Review ended. Edit the note to save it again.",
  closedElsewhere: "Its review was closed on GitHub.",
  closedElsewhereNew: "Its review was closed, and someone started a new one.",
  flurry: "Changed with many files at once. Not saved yet.",
  group: "Waiting for its group. Your changes are safe here.",
  github: "Changed or deleted on GitHub. Not saved yet.",
  tries: "Couldn't save after three tries. Edit it to try again.",
  deleted: "Deleted on GitHub. Submit it to bring it back.",
  baseline: "Here before Stay connected was turned on. Not saved yet.",
  held: "Not saved automatically. Edit it to try again.",
  offline: "Working offline on this note only. Resume sync to reconnect.",
} as const;

export { ATTACHMENTS_SAID } from "../changes/attachment-memory";

export const ATTACHMENT_BOTH = (name: string): string => `The file ${name} changed here and in someone's unpublished changes. Yours stays in your vault.`;

export const STAY_DRAFTS_WORDS = {
  name: "Other people's unpublished changes",
  everyone: "Add them to my notes",
  mine: "Ask me first",
  description: "Other people's saved but unpublished changes. Your own from other devices are always added.",
} as const;

export const STAY_PAUSED_NOTICE = "Stay connected is paused here because this vault's repository changed on another device.";

export const customServerQuestion = (host: string): string => `Sign in to ${host} instead of specgit.com?`;

const manyAtOnce = (count: number): string =>
  count === 1 ? "1 file changed along with many others at once, so it wasn't saved. It's in the Status tab." : `${count} files changed at once, so they weren't saved one by one. They're in the Status tab.`;

export const STAY_SAID = {
  burst: (count: number) => manyAtOnce(count),
  flurry: (count: number) => manyAtOnce(count),
  atStart: (count: number) => `${count} new or renamed ${count === 1 ? "file was" : "files were"} here when Obsidian opened. ${count === 1 ? "It's" : "They're"} in the Status tab.`,
  taken: (count: number) => `${count === 1 ? "A note was" : `${count} notes were`} removed by another app or a sync. Nothing is deleted from GitHub.`,
  editsClosed: (count: number) => `${count === 1 ? "1 note" : `${count} notes`} changed while Obsidian was closed. ${count === 1 ? "It's" : "They're"} in the Status tab, not saved yet.`,
  gaveUp: (count: number) => `specgit couldn't save ${count === 1 ? "a file" : `${count} files`} automatically. ${count === 1 ? "It's" : "They're"} in the Status tab.`,
} as const;
