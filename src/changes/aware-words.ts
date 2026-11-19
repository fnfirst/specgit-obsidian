export const JOIN = "Join";
export const ADD_TO_MY_NOTE = "Add to my note";

export const heldDeletesWords = (count: number): string => `${count} notes were deleted on GitHub at once, so none was moved to the trash.`;

export const noteBarLive = (names: string, many: boolean): string => `${names} ${many ? "are" : "is"} in this note now.`;
export const noteBarDraft = (names: string, many: boolean): string => `${names} ${many ? "have" : "has"} unpublished changes to this note.`;
