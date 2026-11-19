export const COMMENT_WORDS = {
  title: "Comments",
  hide: "Hide comments",
  loading: "Loading…",

  loadFailed: "Failed to load comments",

  emptyWriter: "Select text in the document and choose “Comment” to start a thread.",
  emptyReader: "No comments on this document yet.",
  historyLoading: "Loading earlier revisions…",

  selectionFallback: "(selection)",
  cancel: "Cancel",
  composerPlaceholder: "Add a comment… (Markdown, @mentions). ⌘/Ctrl+Enter to post.",
  comment: "Comment",
  posting: "Posting…",

  waitingForSave: "Waiting for the note to save…",

  saveTimedOut: { title: "The note hasn't saved yet", description: "Your comment was not posted, and your words are still in the box. Press Comment again once the note has saved." },
  postFailedTitle: "Couldn't post the comment",

  replyPlaceholder: "Reply…",
  replySending: "Sending…",
  send: "Send",
  replyFailedTitle: "Couldn't send the reply",

  sendingBadge: "sending…",
  sendingAuthor: "Sending…",
  outdated: "Outdated",
  resolved: "Resolved",
  reopened: "Reopened",
  resolve: "Resolve",
  reopen: "Reopen",
  unknownAuthor: "unknown",

  wholeNote: "On the whole note",
  reopenedEarlierNote: "Someone reopened an earlier copy of this conversation on GitHub. Replies here continue it on the current revision.",
  resolvedIn: (pr: number): string => `Resolved in #${pr}`,
  revision: (pr: number): string => `Revision #${pr}`,

  apply: "Apply suggestion",
  applying: "Applying…",
  applyFailedTitle: "Couldn't apply the suggestion",
  applyFailedBody: "The text it targets has been edited. Fix the sentence directly instead.",
  saveFailedTitle: "Couldn't save the suggestion",

  viewVersion: "View in that version",

  openLine: (count: number): string => `${count} open`,
  resolveAll: "Resolve all",

  saveFailed: "The comment couldn't be saved.",

  needsReview: "Comments need an open review. Starting one automatically failed. Make any edit, then post.",
} as const;
