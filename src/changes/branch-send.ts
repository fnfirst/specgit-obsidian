import { toLf } from "../disk/line-endings";
import { noteName, pathKind } from "../mapping";
import { sameCanvasText, sameDocumentText } from "../shared/review-flow";
import { ROOM_BEHIND, type StepResult } from "../review/review-api";
import { BRANCH_MOVED_AGAIN, DELETED_ON_GITHUB, headOf, MOVED_ATTEMPTS, type Sent, UNREADABLE } from "./flow-helpers";
import type { MainFile } from "../auth/git-copy";
import type { FlowDeps } from "./flow-deps";
import type { ChangeRow } from "./model";
import { mergedWith } from "./note-merge";
import type { SentMemory } from "./sent-memory";

export interface BranchHead {
  text: string;
  sha: string;
}

export interface Behind {
  behind: { head: { source: string; sha: string } | null; message: string };
}

export function behindOf(refused: Extract<StepResult, { ok: false }>, fallback: string): Behind | null {
  return refused.code === ROOM_BEHIND ? { behind: { head: headOf(refused.body), message: refused.message || fallback } } : null;
}

export function sameAsVault(path: string, branch: string, vault: string): boolean {
  if (toLf(branch) === toLf(vault)) return true;
  return pathKind(path) === "board" ? sameCanvasText(branch, vault) : /\.md$/i.test(path) && sameDocumentText(branch, vault);
}

async function forkText(deps: FlowDeps, row: ChangeRow, known: string | undefined): Promise<string | null> {
  const branch = known ?? (await deps.review.status(row.doc))?.reviewBranch;
  if (!branch) return null;
  const seen = await deps.review.mergePreview(row.doc, branch, deps.publishedBranch);
  const base = seen.ok ? (seen.body as { baseSource?: unknown } | null)?.baseSource : undefined;
  return typeof base === "string" && base !== "" ? toLf(base) : null;
}

export interface Meeting {
  there: string;
  held?: string;
  sent: { text: string } | "never";
}

export type Plan = { how: "as-is" } | { how: "merge"; base: string } | { how: "from-fork" };

export function planMeeting({ there, held, sent }: Meeting): Plan {
  if (held !== undefined) return held === there ? { how: "as-is" } : { how: "merge", base: held };
  if (sent === "never") return { how: "from-fork" };
  return sent.text === there ? { how: "as-is" } : { how: "merge", base: sent.text };
}

export type Levelled = { text: string; with?: string } | null | "unreadable" | "deleted";

export const deletedOnGitHub = (row: ChangeRow, main: MainFile): boolean => main.kind === "absent" && row.change.kind === "edited" && row.change.base !== null;

export const lastMatched = (row: ChangeRow, main: MainFile): boolean => main.kind === "file" && row.change.base !== null && main.sha === row.change.base;

export async function levelWith(deps: FlowDeps, row: ChangeRow, text: string, main: MainFile): Promise<Levelled> {
  if (main.kind === "unreadable") return "unreadable";
  if (deletedOnGitHub(row, main)) return "deleted";
  if (main.kind === "absent" || lastMatched(row, main)) return { text };
  const merged = await mergedWith(deps, row, text, main.text);
  return merged === null ? null : { text: merged, with: main.sha };
}

export async function sendThroughBranch(
  host: { readonly deps: FlowDeps; readonly memory: SentMemory },
  row: ChangeRow,
  text: string,
  first: BranchHead | undefined,
  send: (body: string, there: BranchHead | undefined, levelledWith: string | null) => Promise<Sent | Behind>,
  from: { branch?: string; held?: string; level: "level" | ((text: string) => Promise<Levelled>) },
): Promise<Sent> {
  const { deps, memory } = host;
  const name = noteName(row.change.path);
  let there = first;
  for (let attempt = 1; ; attempt++) {
    let body = text;
    let levelledWith: string | null = null;
    if (there && !sameAsVault(row.change.path, there.text, text)) {
      const sent = from.held === undefined ? await memory.lastSent(row, there, from.branch) : "never";
      if (sent === "unreadable") return { ok: false, unreadable: true, message: UNREADABLE(name) };
      const plan = planMeeting({ there: there.text, held: from.held, sent });
      if (plan.how !== "as-is") {
        const other = row.theirs ? { teammate: row.theirs.by, ...(row.theirs.draft ? {} : { submitted: true as const }) } : "github";
        let mine: Levelled = { text };
        if (plan.how === "from-fork" && from.level !== "level") mine = await from.level(text);
        if (mine === "unreadable") return { ok: false, unreadable: true, message: UNREADABLE(name) };
        if (mine === "deleted") return { ok: false, message: DELETED_ON_GITHUB(name) };
        const merged = mine === null ? null : await mergedWith(deps, row, mine.text, there.text, plan.how === "merge" ? plan.base : await forkText(deps, row, from.branch), other);
        if (mine === null || merged === null) return { ok: false, held: true };
        body = merged;
        levelledWith = mine.with ?? null;
      }
    }
    const answer = await send(body, there, levelledWith);
    if (!("behind" in answer)) return answer;
    const { head, message } = answer.behind;
    if (head === null) return { ok: false, message, moved: true };
    if (attempt >= MOVED_ATTEMPTS) return { ok: false, message: BRANCH_MOVED_AGAIN(name) };
    there = { text: head.source, sha: head.sha };
  }
}
