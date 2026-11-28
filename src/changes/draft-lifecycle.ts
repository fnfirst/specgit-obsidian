import { isGroupBranch, sameLogin } from "../shared/review-flow";
import { reviewIsOpen } from "../review/review-api";
import type { FlowDeps } from "./flow-deps";
import { isAnotherAuthor } from "./review-owner";

export interface DraftCloseHooks {
  clearUploaded(): void;
  forgetMemory(path: string): void;
  onAbandonStart?(path: string, expectPr: number | null, done: Promise<boolean>): void;
}

const lookedInboundRename = new WeakMap<object, (from: string, to: string) => void>();

export function bindLookedInboundRename(looked: object, onRename: (from: string, to: string) => void): void {
  lookedInboundRename.set(looked, onRename);
}

export function notifyLookedInboundRename(looked: object, from: string, to: string): void {
  lookedInboundRename.get(looked)?.(from, to);
}

export async function closeSupersededDraftsFor(
  newPath: string,
  deps: FlowDeps,
  hooks: DraftCloseHooks,
  pendingRetries: Set<string>,
): Promise<void> {
  const sources = [...deps.model.draftRenameSources(newPath)];
  if (sources.length === 0) {
    pendingRetries.delete(newPath);
    return;
  }
  let needsRetry = false;
  for (const oldPath of sources) {
    if (oldPath === newPath || deps.vault.exists(oldPath) || (await deps.readText(oldPath)) !== null || deps.model.hasRepoFile(oldPath)) {
      deps.model.forgetDraftRenameSource(newPath, oldPath);
      continue;
    }
    const oldDoc = deps.documentFor(oldPath);
    if (!oldDoc) {
      deps.model.forgetDraftRenameSource(newPath, oldPath);
      continue;
    }
    const oldMain = await deps.gitFile(oldDoc);
    if (oldMain.kind === "unreadable") {
      needsRetry = true;
      continue;
    }
    if (oldMain.kind === "file") {
      deps.model.forgetDraftRenameSource(newPath, oldPath);
      continue;
    }
    const status = await deps.review.status(oldDoc);
    if (status === null) {
      needsRetry = true;
      continue;
    }
    if (!reviewIsOpen(status) || !status.reviewBranch) {
      hooks.forgetMemory(oldPath);
      deps.model.learnSent(oldPath, null);
      deps.model.retireDraftSource(oldPath);
      deps.model.forgetDraftRenameSource(newPath, oldPath);
      continue;
    }
    const viewer = deps.viewerLogin();
    const ownDraft =
      !isGroupBranch(status.reviewBranch) &&
      !status.pr?.group &&
      status.pr?.isDraft !== false &&
      !isAnotherAuthor(status.pr?.authorLogin ?? null, viewer);
    if (!ownDraft) {
      deps.model.forgetDraftRenameSource(newPath, oldPath);
      continue;
    }
    const expectPr = status.pr && status.pr.number > 0 ? status.pr.number : undefined;
    const closed = await deps.review.abandon(oldDoc, undefined, expectPr);
    if (!closed.ok && closed.status !== 404) {
      if (closed.status === 0 || closed.status === 429 || closed.status >= 500) {
        needsRetry = true;
        continue;
      }
      deps.model.forgetDraftRenameSource(newPath, oldPath);
      continue;
    }
    hooks.clearUploaded();
    hooks.forgetMemory(oldPath);
    deps.model.learnSent(oldPath, null);
    deps.model.learn(oldPath, { reviewBranch: null, pr: null });
    deps.model.retireDraftSource(oldPath);
    deps.model.forgetDraftRenameSource(newPath, oldPath);
    deps.model.clearInFlightPath(oldPath, status.reviewBranch, expectPr ?? null);
  }
  if (needsRetry) pendingRetries.add(newPath);
  else pendingRetries.delete(newPath);
}

export async function closeOneRetiredDraft(
  oldPath: string,
  deps: FlowDeps,
  hooks: DraftCloseHooks,
): Promise<boolean> {
  if (deps.vault.exists(oldPath) || (await deps.readText(oldPath)) !== null || deps.model.hasRepoFile(oldPath)) return true;
  const oldDoc = deps.documentFor(oldPath);
  if (!oldDoc) return true;
  const oldMain = await deps.gitFile(oldDoc);
  if (oldMain.kind === "unreadable") return false;
  if (oldMain.kind === "file") return true;
  const status = await deps.review.status(oldDoc);
  if (status === null) return false;
  if (!reviewIsOpen(status) || !status.reviewBranch) {
    return true;
  }
  const viewer = deps.viewerLogin();
  const ownDraft =
    !isGroupBranch(status.reviewBranch) &&
    !status.pr?.group &&
    status.pr?.isDraft !== false &&
    !isAnotherAuthor(status.pr?.authorLogin ?? null, viewer);
  if (!ownDraft) return true;
  const expectPr = status.pr && status.pr.number > 0 ? status.pr.number : undefined;
  const closed = await deps.review.abandon(oldDoc, undefined, expectPr);
  if (!closed.ok && closed.status !== 404) {
    return !(closed.status === 0 || closed.status === 429 || closed.status >= 500);
  }
  hooks.clearUploaded();
  hooks.forgetMemory(oldPath);
  deps.model.learnSent(oldPath, null);
  deps.model.learn(oldPath, { reviewBranch: null, pr: null });
  deps.model.clearInFlightPath(oldPath, status.reviewBranch, expectPr ?? null);
  return true;
}

export async function closeOneDeletedDraft(
  path: string,
  deps: FlowDeps,
  hooks: DraftCloseHooks,
): Promise<"done" | "retry"> {
  if (deps.model.isSupersededDraftSource(path) || deps.model.hasRepoFile(path) || !deps.model.hasPendingDraftDelete(path)) {
    deps.model.finishDraftDelete(path);
    return "done";
  }
  const doc = deps.documentFor(path);
  if (!doc) {
    deps.model.finishDraftDelete(path);
    return "done";
  }
  const beforeSentSha = deps.model.sentSha(path);
  const beforeSentTo = deps.model.sentTo(path);
  const isNewerRecreatedSave = (closedPrKey: string | null): boolean => {
    if (!deps.vault.exists(path)) return false;
    const nowSha = deps.model.sentSha(path);
    const nowTo = deps.model.sentTo(path);
    return nowSha !== null && (nowSha !== beforeSentSha || nowTo !== beforeSentTo) && (closedPrKey === null || nowTo !== closedPrKey);
  };
  const main = await deps.gitFile(doc);
  if (main.kind === "unreadable") return "retry";
  if (main.kind === "file" || !deps.model.hasPendingDraftDelete(path) || isNewerRecreatedSave(null)) {
    deps.model.finishDraftDelete(path);
    return "done";
  }
  const status = await deps.review.status(doc);
  if (status === null) return "retry";
  if (!deps.model.hasPendingDraftDelete(path) || isNewerRecreatedSave(null)) {
    deps.model.finishDraftDelete(path);
    return "done";
  }
  if (deps.vault.exists(path) && deps.model.isSavingDraft(path)) return "retry";
  if (!reviewIsOpen(status) || !status.reviewBranch) {
    if (!isNewerRecreatedSave(null)) {
      hooks.forgetMemory(path);
      deps.model.learnSent(path, null);
    }
    deps.model.finishDraftDelete(path);
    if (!deps.vault.exists(path)) {
      deps.model.recordUnflushedLiveDelete(path);
      deps.model.settledDelete(path);
    }
    return "done";
  }
  const viewer = deps.viewerLogin();
  const canAbandon =
    !isGroupBranch(status.reviewBranch) &&
    !status.pr?.group &&
    deps.model.groupOf(path) === undefined &&
    status.pr?.isDraft !== false &&
    (!isAnotherAuthor(status.pr?.authorLogin ?? null, viewer) || deps.model.viewerWroteInDraft(path));
  if (!canAbandon) {
    deps.model.finishDraftDelete(path);
    return "done";
  }
  const expectPr = status.pr && status.pr.number > 0 ? status.pr.number : undefined;
  const closedKey = expectPr !== undefined ? `pr:${expectPr}` : null;
  deps.model.recordDeletedDraftTarget(path, expectPr ?? null, beforeSentSha);
  let resolveAbandon!: (abandonedOk: boolean) => void;
  const abandonDone = new Promise<boolean>((resolve) => {
    resolveAbandon = resolve;
  });
  hooks.onAbandonStart?.(path, expectPr ?? null, abandonDone);
  let closed: Awaited<ReturnType<FlowDeps["review"]["abandon"]>>;
  let abandonedOk = false;
  try {
    closed = await deps.review.abandon(doc, undefined, expectPr);
    abandonedOk = Boolean(closed.ok || closed.status === 404);
  } finally {
    resolveAbandon(abandonedOk);
  }
  if (!closed.ok && closed.status !== 404) {
    if (closed.status === 0 || closed.status === 429 || closed.status >= 500) return "retry";
    deps.model.finishDraftDelete(path);
    return "done";
  }
  hooks.clearUploaded();
  const existsNow = deps.vault.exists(path);
  const newerRecreated = isNewerRecreatedSave(closedKey);
  if (!newerRecreated) {
    hooks.forgetMemory(path);
    deps.model.learnSent(path, null);
    if (!existsNow) deps.model.learn(path, { reviewBranch: null, pr: null });
  }
  deps.model.clearInFlightPath(path, status.reviewBranch, expectPr ?? null);
  deps.model.change({ kind: "gone", prNumbers: expectPr !== undefined ? [expectPr] : [], paths: existsNow ? [] : [doc.path], groupIds: [] });
  deps.model.finishDraftDelete(path);
  if (!existsNow) {
    deps.model.settledDelete(path);
  }
  return "done";
}

export function isViewerWrittenDraftEntry(
  one: {
    isReviewBranch?: boolean;
    changedStatus?: string;
    branch?: string;
    prIsDraft?: boolean;
    prAuthorLogin?: string | null;
    authorLogin?: string | null;
    writers?: readonly string[];
  },
  viewer: string,
): boolean {
  if (one.isReviewBranch === false || one.changedStatus === "removed") return false;
  if (typeof one.branch === "string" && isGroupBranch(one.branch)) return false;
  if (one.prIsDraft === false) return false;
  const author = one.prAuthorLogin ?? one.authorLogin ?? null;
  return viewer === "" ? author === null : !isAnotherAuthor(author, viewer) || one.writers?.some((w) => sameLogin(w, viewer)) === true;
}

export function hasViewerWrittenEntry(
  entries: ReadonlyArray<{
    isReviewBranch: boolean;
    changedStatus?: string;
    branch: string;
    prIsDraft?: boolean;
    prAuthorLogin?: string | null;
    authorLogin?: string | null;
    writers?: readonly string[];
  }> | undefined,
  viewer: string,
): boolean {
  return entries !== undefined && entries.some((one) => one.isReviewBranch && isViewerWrittenDraftEntry(one, viewer));
}
