import { type Budget, withoutFinalBreaks } from "./diff";
import { bodyOf, frontmatterRegion } from "./front-matter";
import { mergeRegions, twoWayRegions } from "./merge";
import { conflictsIn, type Region, theirsStanding } from "./regions";

export interface RoomMeeting {
  source: "room";
  editor: string;
  room: string;
  base: string | null;
  emptied: boolean;
  git: string | null | undefined;
  baseIsGit: boolean;
  readOnly: boolean;
}

export interface GitMeeting {
  source: "git";
  editor: string;
  room: string;
  base: string | null;
}

export type Meeting = RoomMeeting | GitMeeting;

export type Joined =
  | { kind: "text"; text: string }
  | { kind: "review"; regions: Region[]; fromBase: boolean }
  | { kind: "apart" }
  | { kind: "needs-git" };

const text = (words: string): Joined => ({ kind: "text", text: words });

export function roomIsUnwritten(room: string, editor: string): boolean {
  if (room === "") return true;
  return frontmatterRegion(room) !== "" && bodyOf(room).trim() === "" && bodyOf(editor).trim() !== "";
}

export function reconcile(meeting: Meeting, budget: Budget): Joined {
  const joined = decide(meeting, budget);
  if (meeting.source === "git" || !meeting.readOnly || joined.kind === "needs-git") return joined;
  return joined.kind === "text" && joined.text === meeting.room ? joined : { kind: "apart" };
}

function againstGit(merged: string, { editor, room, base, baseIsGit, git }: Pick<RoomMeeting, "editor" | "room" | "base" | "baseIsGit" | "git">, budget: Budget): Joined {
  if (merged === room || base === null || !baseIsGit || editor === "") return text(merged);
  if (git === undefined) return { kind: "needs-git" };
  if (git === null || withoutFinalBreaks(git) === withoutFinalBreaks(base) || withoutFinalBreaks(git) === withoutFinalBreaks(room)) return text(merged);
  const regions = mergeRegions(base, merged, git, budget);
  return conflictsIn(regions) === 0 ? text(theirsStanding(regions)) : { kind: "review", regions, fromBase: true };
}

function decide(meeting: Meeting, budget: Budget): Joined {
  const { editor, room, base } = meeting;
  if (editor === room || withoutFinalBreaks(editor) === withoutFinalBreaks(room)) return text(room);
  if (meeting.source === "git") {
    if (base !== null) {
      const regions = mergeRegions(base, editor, room, budget);
      return conflictsIn(regions) > 0 ? { kind: "review", regions, fromBase: true } : text(theirsStanding(regions));
    }
    return { kind: "review", regions: twoWayRegions(editor, room, budget), fromBase: false };
  }
  if (roomIsUnwritten(room, editor)) return text(editor);
  if (editor === "" && !meeting.emptied) return text(room);
  if (base !== null) {
    const regions = mergeRegions(base, editor, room, budget);
    if (conflictsIn(regions) > 0 && editor !== "") return { kind: "review", regions, fromBase: true };
    return againstGit(theirsStanding(regions), meeting, budget);
  }
  if (meeting.git === undefined) return { kind: "needs-git" };
  if (meeting.git !== null && withoutFinalBreaks(editor) === withoutFinalBreaks(meeting.git)) return text(room);
  return { kind: "review", regions: twoWayRegions(editor, room, budget), fromBase: false };
}
