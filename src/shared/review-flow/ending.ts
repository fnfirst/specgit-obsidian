import { RECORD_WRITES } from "./burst";
import { heldKind, type GroupHold } from "./groups";
import { asksBeforeSeparate } from "./separate-reviews";

export const ENDING_FILES_PER_STEP = 15;
export const ENDING_WRITES_PER_FILE = 3;
export const ENDING_STEP_RECORD_WRITES = RECORD_WRITES;
export const ENDING_WRITES_PER_HOUR = 300;
export const ENDING_STEP_MS = Math.round(((ENDING_FILES_PER_STEP * ENDING_WRITES_PER_FILE + ENDING_STEP_RECORD_WRITES) * 3_600_000) / ENDING_WRITES_PER_HOUR);

export type EndingStopped = "no_credential" | "no_access" | "failed";

export type EndingStop = EndingStopped | "held";

export const endingWaitsForPick = (row: { ending?: number | object | null; hold: GroupHold | null }): boolean => Boolean(row.ending) && heldKind(row.hold);

export const endingStopOf = (row: { ending?: number | object | null; hold: GroupHold | null; endingStopped?: EndingStopped | null }): EndingStop | undefined =>
  row.endingStopped ?? (endingWaitsForPick(row) ? "held" : undefined);

export interface EndingProgress {
  remaining: number;
  total: number;
  stopped?: EndingStop;
}

export const endingMinutes = (files: number): number => Math.max(0, Math.ceil(files / ENDING_FILES_PER_STEP) - 1) * (ENDING_STEP_MS / 60_000);

export function endingTime(files: number): string {
  const minutes = endingMinutes(files);
  if (minutes === 0) return "a moment";
  if (minutes < 60) return `about ${Math.round(minutes)} minutes`;
  const hours = Math.round(minutes / 6) / 10;
  return hours === 1 ? "about an hour" : `about ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

export function endingConfirm(files: number): string | null {
  if (!asksBeforeSeparate(files)) return null;
  if (files <= ENDING_FILES_PER_STEP) return `This makes ${files} separate reviews, one for each file. If some files already have their own review, fewer new ones are made.`;
  return `This makes ${files} separate reviews, one for each file. It can take up to ${endingTime(files)}, because GitHub limits how fast reviews can be created. If some files already have their own review, fewer new ones are made and it goes faster. While it goes, the group stays here, shrinking, and you can stop it and keep what is left.`;
}

const stopWords = (stopped: EndingStop): string => {
  switch (stopped) {
    case "no_access":
      return "the person who started it can no longer push here. Anyone who can push here carries it on by opening this list.";
    case "no_credential":
      return "the person who started it is signed out. Anyone who can push here carries it on by opening this list.";
    case "held":
      return "a change was made on GitHub as well as here. Pick which to keep, and it carries on.";
    case "failed":
      return "a step kept failing. The files not yet given back are still in the group, and anyone who can push here can try again by opening this list.";
  }
};

export const endingWords = ({ remaining, total, stopped }: EndingProgress): string =>
  stopped
    ? `Taking this group apart stopped at ${total - remaining} of ${total} files: ${stopWords(stopped)}`
    : `Taking this group apart: ${total - remaining} of ${total} files are back with their own reviews. Publishing and adding wait until it is done.`;

export const endingStartedWords = (name: string, progress?: EndingProgress): string =>
  `Taking ${name} apart${progress ? `: ${progress.remaining} of ${progress.total} files are still in it` : ", a few files at a time"}. The card shows how far it is, and you can stop it.`;

export const ENDING_STOP = "Stop";

export const endingRefusal = (remaining: number): string =>
  `This group is being taken apart (${remaining} files left). Publish and submit wait until it is done. You can stop it and keep the files that are left in the group.`;
