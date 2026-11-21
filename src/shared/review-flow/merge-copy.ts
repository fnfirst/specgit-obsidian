export type MergeKeep = "ours" | "theirs" | "both";

export const MERGE = {
  keep: (kind: MergeKeep, theirs: string): string => (kind === "ours" ? "Keep mine" : kind === "theirs" ? `Keep ${theirs}` : "Keep both"),
  edit: "Edit",
  edited: "Edited",
  editAria: "Edit the resolution for this conflict",
  conflictOf: (number: number, total: number): string => `Conflict ${number} of ${total}`,
  resolved: (chosen: number, total: number): string => `${chosen} of ${total} resolved`,
  keepAll: (kind: "ours" | "theirs", theirs: string): string => (kind === "ours" ? "Keep mine for all" : `Keep ${theirs} for all`),
  intro: (side: string, noun: string, conflicts: number): string =>
    `Both you and ${side} changed the ${conflicts === 1 ? "same part" : "same parts"} of this ${noun}. For each one, choose which version to keep. Nothing is lost until you decide.` +
    (conflicts > 1 ? " To keep one side everywhere, use the buttons at the bottom." : ""),
  unknown: "This document and GitHub's version differ here. Choose which to keep in each place.",
  clean: {
    title: "No conflicting edits",
    body: (side: string, noun: string): string => `Your changes and the changes on ${side} touch different parts of the ${noun}, so they merged automatically. Review the result below, then apply.`,
  },
  previewResult: "Preview merged result",
  hideResult: "Hide merged result",
  unchanged: (count: number, unit: "block" | "line"): string => `${count} unchanged ${unit}s`,
} as const;
