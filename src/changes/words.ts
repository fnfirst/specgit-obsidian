export const CHECKING_WORDS = "Checking…";
export const GIVE_ACCESS_LABEL = "Give specgit access";
export const notInstalledWords = (owner: string): string => `specgit doesn't have access to ${owner} on GitHub yet. Click Give specgit access.`;

export const DELETE_CLOSE_DELAY_MS = 5_000;
export const UNDO_LABEL = "Undo";
export const closingDraftReviewWords = (name: string): string => `Closing the draft review of ${name}.`;
export const closedDraftReviewWords = (name: string): string => `Closed the draft review of ${name}.`;
export const couldntRestoreDraftWords = (name: string): string => `Couldn't restore ${name}.`;
