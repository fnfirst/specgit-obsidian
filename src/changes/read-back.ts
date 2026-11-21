import type { BranchFile } from "../auth/git-copy";
import type { DocumentRef } from "../mapping";
import { isLostAnswerResult, type ReviewApi, type ReviewStatus, type StepResult } from "../review/review-api";
import { sameStructuredText } from "./same-text";

const READ_BACK_WAITS_MS = [1_000, 2_000, 3_000, 4_000];

export async function readBack(there: () => Promise<boolean>, pause: (ms: number) => Promise<void>): Promise<boolean> {
  for (const wait of READ_BACK_WAITS_MS) {
    await pause(wait);
    if (await there()) return true;
  }
  return false;
}

export interface ReadBackDeps {
  review: Pick<ReviewApi, "status" | "groups">;
  branchFile(doc: DocumentRef, branch: string): Promise<BranchFile>;
  pause: (ms: number) => Promise<void>;
}

const holdsText = (path: string, held: string, text: string): boolean => held === text || sameStructuredText(path, held, text);

export async function reviewHolds(deps: ReadBackDeps, doc: DocumentRef, text: string, status?: ReviewStatus | null): Promise<boolean | null> {
  const read = status ?? (await deps.review.status(doc));
  if (read === null) return null;
  if (read.reviewBranch === null) return false;
  const there = await deps.branchFile(doc, read.reviewBranch);
  return there.kind === "unreadable" ? null : there.kind === "file" && holdsText(doc.path, there.text, text);
}

export async function saveLandedAs(deps: ReadBackDeps, doc: DocumentRef, text: string): Promise<{ text: string; sha: string } | null> {
  let found: { text: string; sha: string } | null = null;
  const there = async (): Promise<boolean> => {
    const read = await deps.review.status(doc);
    if (read === null || read.reviewBranch === null) return false;
    const file = await deps.branchFile(doc, read.reviewBranch);
    if (file.kind !== "file" || !holdsText(doc.path, file.text, text)) return false;
    found = { text: file.text, sha: file.sha };
    return true;
  };
  return (await readBack(there, deps.pause)) ? found : null;
}

export const saveLanded = async (deps: ReadBackDeps, doc: DocumentRef, text: string): Promise<boolean> => (await saveLandedAs(deps, doc, text)) !== null;

export async function groupLanded(deps: ReadBackDeps, repo: string, paths: readonly string[], id?: string): Promise<string | null> {
  let found: string | null = null;
  const holds = async (): Promise<boolean> => {
    const read = await deps.review.groups(repo);
    found = read.kind === "groups" ? (Object.values(read.overviews).find((one) => (id === undefined || one.id === id) && paths.every((path) => one.paths.includes(path)))?.id ?? null) : null;
    return found !== null;
  };
  return (await readBack(holds, deps.pause)) ? found : null;
}

export const submitLanded = (deps: ReadBackDeps, doc: DocumentRef): Promise<boolean> =>
  readBack(async () => {
    const pr = (await deps.review.status(doc))?.pr;
    return pr !== undefined && pr !== null && !pr.isDraft && pr.state !== "draft";
  }, deps.pause);

export class ReadBacks {
  constructor(
    private readonly deps: () => ReadBackDeps,
    private readonly found: () => void,
  ) {}

  async save(doc: DocumentRef, text: string, saved: StepResult): Promise<StepResult> {
    if (!isLostAnswerResult(saved)) return saved;
    const held = await saveLandedAs(this.deps(), doc, text);
    if (held === null) return saved;
    this.found();
    return { ok: true, body: { unchanged: true, source: held.text, contentSha: held.sha } };
  }

  async group(answer: StepResult, repo: string, paths: readonly string[], id?: string): Promise<string | null> {
    const made = isLostAnswerResult(answer) ? await groupLanded(this.deps(), repo, paths, id) : null;
    if (made !== null) this.found();
    return made;
  }

  async submit(doc: DocumentRef, answer: StepResult): Promise<StepResult> {
    if (!isLostAnswerResult(answer) || !(await submitLanded(this.deps(), doc))) return answer;
    this.found();
    return { ok: true, body: {} };
  }
}
