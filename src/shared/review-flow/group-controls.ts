import { heldKind, type GroupOverview } from "./groups";

export interface GroupControls {

  ungroup: boolean;

  stop: boolean;

  picks: { mine: boolean; theirs: boolean };
}

export function groupControls(overview: Pick<GroupOverview, "hold" | "ending">): GroupControls {
  const ending = overview.ending;
  return {
    ungroup: !ending,
    stop: Boolean(ending),
    picks: { mine: heldKind(overview.hold), theirs: overview.hold === "overlap" },
  };
}

export const stoppedEndingWords = (name: string, remaining: number | undefined): string =>
  remaining === undefined
    ? `Stopped taking ${name} apart. The files still in it stay in it.`
    : `Stopped taking ${name} apart. ${remaining === 1 ? "1 file stays" : `${remaining} files stay`} in the group.`;
