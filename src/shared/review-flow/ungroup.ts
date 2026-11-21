import { endingStartedWords, type EndingProgress } from "./ending";
import { releasedChange, type InFlightChange } from "./optimistic";
import { keptWords, ungroupedWords, type KeptBranch } from "./status-list";

export interface UngroupAnswer {
  id?: string;
  files?: Extract<InFlightChange, { kind: "released" }>["files"];
  ended?: boolean;
  ending?: EndingProgress;
  kept?: KeptBranch;
  lost?: number;
  unsent?: string[];
}

export interface UngroupPreview {
  unsent: number;
  own: number;
}

export const ungroupTitle = (name: string): string => `Ungroup ${name}?`;

export function ungroupUnsentConfirm(preview: UngroupPreview): string {
  const total = preview.unsent + preview.own;
  if (preview.own === 0) return `Its ${total} files go back to the Status tab as separate files, and the group's pull request is closed. Nothing in your vault changes.`;
  const why = preview.own === 1 ? "it already had one, has open comments, or has" : "they already had one, have open comments, or have";
  const reviews = `${preview.own} ${preview.own === 1 ? "file will have" : "files will have"} a review of ${preview.own === 1 ? "its" : "their"} own, because ${why} changes on GitHub that aren't in this vault.`;
  return `${preview.unsent} of its ${total} files go back to the Status tab as separate files, and the group's pull request is closed. ${reviews} Nothing in your vault changes.`;
}

export const ungroupedUnsentWords = (name: string, unsent: number): string => `Ungrouped ${name}. ${unsent === 1 ? "1 file is" : `${unsent} files are`} back in Changes, unsent. Nothing in your vault changed.`;

export const unsentStepWords = (unsent: number): string => ` ${unsent === 1 ? "1 file is" : `${unsent} files are`} back in Changes, unsent.`;

export function ungroupChange(answer: UngroupAnswer, viewer: string | null, at: string): InFlightChange | null {
  if (!answer.id) return null;
  const files = answer.files ?? [];
  const ended = answer.ended === true;
  if (!ended && files.length === 0 && !answer.ending) return null;
  return releasedChange(answer.id, ended, files, viewer, at, ended ? undefined : answer.ending);
}

const lostWords = (lost: number | undefined): string =>
  lost ? ` ${lost} ${lost === 1 ? "file was" : "files were"} no longer on GitHub, so ${lost === 1 ? "it has" : "they have"} no review to be given back.` : "";

export function ungroupOutcomeWords(answer: UngroupAnswer, name: string): string {
  if (answer.ended !== true) return `${endingStartedWords(name, answer.ending)}${answer.unsent?.length ? unsentStepWords(answer.unsent.length) : ""}${lostWords(answer.lost)}`;
  if (answer.unsent?.length && !answer.kept && (answer.files ?? []).length === 0) return `${ungroupedUnsentWords(name, answer.unsent.length)}${lostWords(answer.lost)}`;
  return `${answer.kept ? keptWords(`Ungrouped ${name}`, answer.kept) : ungroupedWords(name)}${lostWords(answer.lost)}`;
}
