import type { GroupLabel } from "./pr-info";
import { groupStanding } from "./group-words";
import { upToDateWords } from "./lifecycle-copy";
import type { ReviewState } from "./review-state";

export interface SummaryLine {
  short: string;
  full: string;
  pr: number | null;
}

function waitingPhrase(label: string): string {
  if (label === "Your review") return "Waiting for you";
  if (label === "Waiting on review") return "Needs approval";
  if (label === "Waiting on checks") return "Checks running";
  if (label === "Changes requested") return "Asked for changes";
  if (label === "Blocked on GitHub") return "Blocked on GitHub";
  return "Waiting";
}

function phrase(state: ReviewState, branch: string, savesAsYouType: boolean): string {
  switch (state.kind) {
    case "none":
      return `Matches ${branch}`;
    case "published":
      return `Live on ${branch}`;
    case "conflicts":
      return `Conflicts with ${branch}`;
    case "in_progress":
      return savesAsYouType ? "Saving as you type" : "Saved when you submit";
    case "waiting":
      return waitingPhrase(state.label);
    case "auto_publish":
      return "Publishes when approved";
    case "in_review":
      return state.label === "Ready to publish" ? "Nothing blocks it" : "Asked for review";
    default: {
      const _exhaustive: never = state.kind;
      return _exhaustive;
    }
  }
}

export function summaryLine(state: ReviewState, { pr, branch, group, savesAsYouType = true }: { pr: number | null; branch: string; group?: GroupLabel | null; savesAsYouType?: boolean }): SummaryLine {
  const number = state.kind === "none" || state.kind === "published" ? null : pr;
  if (state.kind === "none") return { short: phrase(state, branch, savesAsYouType), full: upToDateWords(branch), pr: null };
  if (state.kind === "published") return { short: phrase(state, branch, savesAsYouType), full: `${state.title}.`, pr: null };
  if (group) {
    return { short: `In ${group.name} · ${group.files} ${group.files === 1 ? "file" : "files"}`, full: `${state.title.replace(/\.$/, "")}. ${groupStanding(group)}`, pr: number };
  }
  return { short: phrase(state, branch, savesAsYouType), full: state.title, pr: number };
}
