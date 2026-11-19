import type { ReviewSide } from "../editor/services";
import { Budget } from "../disk/diff";
import { toLf } from "../disk/line-endings";
import { reconcile } from "../disk/reconcile";
import { noteName } from "../mapping";
import type { FlowDeps } from "./flow-deps";
import { matchedBase } from "./merge-base";
import type { ChangeRow } from "./model";

export async function mergedWith(deps: FlowDeps, row: ChangeRow, mine: string, theirs: string, given?: string | null, other: ReviewSide = "github"): Promise<string | null> {

  const base = given !== undefined ? given : await matchedBase(row.change.base, (sha) => deps.gitBlob(row.doc, sha), () => deps.baseText(row.change.path));
  const joined = reconcile({ editor: toLf(mine), room: toLf(theirs), base, baseIsGit: false, emptied: false, git: theirs, readOnly: false }, deps.budget?.() ?? new Budget(400));
  if (joined.kind === "text") return joined.text;
  if (joined.kind === "review") {
    const abort = new AbortController();
    return deps.chooseWhatToKeep({ name: noteName(row.change.path), regions: joined.regions, fromBase: joined.fromBase, other, settle: () => null, signal: abort.signal });
  }
  return mine;
}
