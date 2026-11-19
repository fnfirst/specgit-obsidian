export interface CleanRegion {
  type: "clean";
  lines: string[];
}

export interface ConflictRegion {
  type: "conflict";

  index: number;
  ours: string[];
  theirs: string[];
  base: string[];
}

export type MergeRegion = CleanRegion | ConflictRegion;

export interface ThreeWayMerge {
  regions: MergeRegion[];
  conflicts: ConflictRegion[];

  hasConflicts: boolean;

  cleanResult: string | null;
}

export type ConflictChoice =
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "both" }
  | { kind: "custom"; text: string };

function choiceLines(conflict: ConflictRegion, choice: ConflictChoice): string[] {
  switch (choice.kind) {
    case "ours":
      return conflict.ours;
    case "theirs":
      return conflict.theirs;
    case "both":
      return [...conflict.ours, ...conflict.theirs];
    case "custom":

      return choice.text === "" ? [] : choice.text.split("\n");
  }
}

export function conflictProgress(
  merge: ThreeWayMerge,
  choices: ReadonlyMap<number, ConflictChoice>,
): { chosen: number; total: number; done: boolean } {
  const total = merge.conflicts.length;
  const chosen = merge.conflicts.filter((c) => choices.has(c.index)).length;
  return { chosen, total, done: chosen === total };
}

export function buildResolvedText(
  merge: ThreeWayMerge,
  choices: ReadonlyMap<number, ConflictChoice>,
): string {
  const lines: string[] = [];
  for (const region of merge.regions) {
    if (region.type === "clean") {
      lines.push(...region.lines);
      continue;
    }
    const choice = choices.get(region.index);
    if (!choice) throw new Error(`Conflict ${region.index + 1} has no resolution choice.`);
    lines.push(...choiceLines(region, choice));
  }
  return lines.join("\n");
}
