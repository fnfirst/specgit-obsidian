import type { ReviewSide } from "../editor/services";
import { Budget } from "../disk/diff";
import { toLf } from "../disk/line-endings";
import { buildReviewRequest, mergeFile } from "../disk/structured-merge";
import type { FlowDeps } from "./flow-deps";
import { matchedBase } from "./merge-base";
import type { ChangeRow } from "./model";

export async function mergedWith(deps: FlowDeps, row: ChangeRow, mine: string, theirs: string, given?: string | null, other: ReviewSide = "github"): Promise<string | null> {
  const base = given !== undefined ? given : await matchedBase(row.change.base, (sha) => deps.gitBlob(row.doc, sha), () => deps.baseText(row.change.path));
  const merged = mergeFile(row.change.path, base, toLf(mine), toLf(theirs), deps.budget?.() ?? new Budget(400));
  if (merged.kind === "clean") return merged.text;
  return deps.chooseWhatToKeep(buildReviewRequest(row.change.path, merged.review, { other, signal: new AbortController().signal }));
}
