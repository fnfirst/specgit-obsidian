export interface ChangeLine {
  kind: "added" | "changed" | "removed" | "moved" | "resized";

  text: string;

  before?: string;
}

export interface MainChanges {

  kind: "document" | "board";

  summary: string;

  lines: ChangeLine[];

  more: number;
}

export const MAX_CHANGE_LINES = 8;
export const MAX_LINE_CHARS = 140;

export type CatchUpPreview =

  | { kind: "no_review" }

  | { kind: "up_to_date" }
  | {
      kind: "behind";

      base: string;

      mainBlob: string;
      changes: MainChanges;

      merge: "clean" | "conflicts";

      conflicts: number;

      submitted: boolean;
    }

  | { kind: "unsupported"; reason: UnsupportedReason; message: string };

export type UnsupportedReason = "removed_on_main" | "other_files" | "no_file";

export type CatchUpResult =
  | { kind: "no_review" }
  | { kind: "up_to_date" }

  | {
      kind: "caught_up";
      reviewBranch: string;

      source: string;
      contentSha: string;
      commitSha: string;
      changes: MainChanges;
    }

  | { kind: "conflicts"; base: string; conflicts: number; changes: MainChanges }

  | { kind: "main_moved"; preview: Extract<CatchUpPreview, { kind: "behind" }> }
  | { kind: "unsupported"; reason: UnsupportedReason; message: string };

export function nothingToCatchUp(preview: Exclude<CatchUpPreview, { kind: "behind" }>): { code: string; text: string } {
  switch (preview.kind) {
    case "no_review":
      return { code: "no_review", text: "specgit sees no review in progress for this document, so there is nothing to catch up. A review starts with the first change to the document." };
    case "up_to_date":
      return { code: "nothing_to_catch_up", text: "The published version hasn't changed this document since the review began, so there is nothing to catch up." };
    case "unsupported":
      return { code: "cannot_catch_up", text: preview.message };
    default:

      return { code: "cannot_catch_up", text: "Couldn't read the published version." };
  }
}

export function oneLine(text: string, max: number = MAX_LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function joinParts(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function documentSummary(counts: { changed: number; added: number; removed: number }): string {
  const parts = [
    counts.changed ? `changed ${plural(counts.changed, "passage")}` : null,
    counts.added ? `added ${plural(counts.added, "passage")}` : null,
    counts.removed ? `took out ${plural(counts.removed, "passage")}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "The published version changed how this document is written, not what it says." : `The published version ${joinParts(parts)}.`;
}

export function boardSummary(counts: { added: number; removed: number; moved: number; resized: number; edited: number; arrows: number }): string {
  const parts = [
    counts.moved ? `moved ${plural(counts.moved, "card")}` : null,
    counts.resized ? `resized ${plural(counts.resized, "card")}` : null,
    counts.edited ? `edited ${plural(counts.edited, "card")}` : null,
    counts.added ? `added ${plural(counts.added, "card")}` : null,
    counts.removed ? `removed ${plural(counts.removed, "card")}` : null,
    counts.arrows ? `changed ${plural(counts.arrows, "arrow")}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "The published version changed how this board is written, not what it shows." : `The published version ${joinParts(parts)}.`;
}
