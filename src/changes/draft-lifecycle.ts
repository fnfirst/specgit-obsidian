import { isGroupBranch } from "../shared/review-flow";
import { reviewIsOpen, type ReviewStatus } from "../review/review-api";
import { gitBlobShaOfText } from "./blob-sha";
import { type ActiveDraftLifecycle, type DoomedDraftInfo, type DoomedDraftRef, RETIRED_DRAFT_TTL_MS } from "./draft-lifecycle-store";
import type { FlowDeps } from "./flow-deps";
import { isAnotherAuthor } from "./review-owner";

export interface DraftCloseHooks {
  clearUploaded(): void;
  forgetMemory(path: string): void;
  onAbandonStart?(path: string, expectPr: number | null, done: Promise<boolean>): void;
}

export interface CloseDoomedResult {
  outcome: "done" | "retry";
  closed: boolean;
}

const lookedInboundRename = new WeakMap<object, (from: string, to: string) => void>();

export function bindLookedInboundRename(looked: object, onRename: (from: string, to: string) => void): void {
  lookedInboundRename.set(looked, onRename);
}

export function notifyLookedInboundRename(looked: object, from: string, to: string): void {
  lookedInboundRename.get(looked)?.(from, to);
}

export function isSoleViewerDraftEntry(
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
  if (viewer === "") {
    return author === null && (one.writers === undefined || one.writers.length === 0);
  }
  if (isAnotherAuthor(author, viewer)) return false;
  if (one.writers !== undefined && one.writers.some((w) => isAnotherAuthor(w, viewer))) return false;
  return true;
}

export function hasSoleViewerDraftEntry(
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
  return entries !== undefined && entries.some((one) => one.isReviewBranch && isSoleViewerDraftEntry(one, viewer));
}

export function hasOtherWriterEntry(
  entries: ReadonlyArray<{
    isReviewBranch?: boolean;
    changedStatus?: string;
    branch?: string;
    prNumber?: number | null;
    prAuthorLogin?: string | null;
    authorLogin?: string | null;
    writers?: readonly string[];
  }> | undefined,
  viewer: string,
  prNumber: number | null = null,
): boolean {
  if (!entries || entries.length === 0) return false;
  for (const one of entries) {
    if (one.isReviewBranch === false || one.changedStatus === "removed") continue;
    if (prNumber !== null && prNumber > 0 && typeof one.prNumber === "number" && one.prNumber > 0 && one.prNumber !== prNumber) {
      continue;
    }
    const author = one.prAuthorLogin ?? one.authorLogin ?? null;
    if (viewer === "") {
      if (author !== null || (one.writers !== undefined && one.writers.length > 0)) return true;
      continue;
    }
    if (isAnotherAuthor(author, viewer)) return true;
    if (one.writers !== undefined && one.writers.some((w) => isAnotherAuthor(w, viewer))) return true;
  }
  return false;
}

export function inboundRetiredRef(
  cached: { sent?: string; sentTo?: string; sha?: string } | undefined,
  entries:
    | ReadonlyArray<{
        isReviewBranch?: boolean;
        changedStatus?: string;
        branch?: string;
        prIsDraft?: boolean;
        prNumber?: number | null;
        docBlobSha?: string | null;
        prAuthorLogin?: string | null;
        authorLogin?: string | null;
        writers?: readonly string[];
      }>
    | undefined,
  viewer = "",
): DoomedDraftRef | null {
  const sentPr = cached?.sentTo?.startsWith("pr:") ? Number(cached.sentTo.slice(3)) : NaN;
  const knownPr = Number.isInteger(sentPr) && sentPr > 0 ? sentPr : null;
  const rawBranch = cached?.sentTo?.startsWith("branch:") ? cached.sentTo.slice(7) : null;
  const knownBranch = rawBranch !== null && rawBranch !== "" ? rawBranch : null;
  const cachedSha = cached?.sent ?? cached?.sha ?? null;
  const active = entries?.find((one) => {
    if (!isSoleViewerDraftEntry(one, viewer)) return false;
    if (knownPr !== null) return one.prNumber === knownPr;
    if (knownBranch !== null) return one.branch === knownBranch;
    if (cachedSha !== null) return one.docBlobSha === cachedSha;
    return false;
  });
  const prNumber = knownPr ?? (typeof active?.prNumber === "number" && active.prNumber > 0 ? active.prNumber : null);
  const branch = knownBranch ?? (typeof active?.branch === "string" && active.branch !== "" ? active.branch : null);
  const sha = cachedSha ?? (typeof active?.docBlobSha === "string" && active.docBlobSha !== "" ? active.docBlobSha : null);
  return prNumber === null && branch === null && sha === null ? null : { prNumber, branch, sha };
}

export function filterDoomedFlightEntries<
  T extends {
    isReviewBranch?: boolean;
    changedStatus?: string;
    branch?: string;
    prIsDraft?: boolean;
    prNumber?: number | null;
    docBlobSha?: string | null;
    prAuthorLogin?: string | null;
    authorLogin?: string | null;
    writers?: readonly string[];
  },
>(
  entries: readonly T[] | undefined,
  ctx: {
    active: ActiveDraftLifecycle | undefined;
    stayOn: boolean;
    present: boolean;
    login: string;
    cachedSent: string | undefined;
    now?: number;
  },
): readonly T[] | undefined {
  if (!entries || entries.length === 0 || !ctx.active) return entries;
  const { active, stayOn, present, login, cachedSent } = ctx;
  if (active.kind === "live-delete" && active.waitingLiveFlush) {
    if (present) return entries;
    const foreign = entries.filter((one) => !isSoleViewerDraftEntry(one, login));
    return foreign.length === entries.length ? entries : foreign.length > 0 ? foreign : undefined;
  }
  if (active.kind === "live-delete") {
    if (!stayOn) return entries;
    if (!present) {
      const foreign = entries.filter((one) => !isSoleViewerDraftEntry(one, login));
      return foreign.length === entries.length ? entries : foreign.length > 0 ? foreign : undefined;
    }
  } else if (active.kind === "superseded") {
    if (!active.recreated) return entries;
  } else if (active.kind === "retired" && active.inbound === true) {
    const expired = ctx.now !== undefined && ctx.now - active.at >= RETIRED_DRAFT_TTL_MS;
    if (present || expired || !active.doomed) return entries;
    const { prNumber, branch, sha } = active.doomed;
    const kept = entries.filter((one) => {
      if (!isSoleViewerDraftEntry(one, login)) return true;
      if (prNumber !== null) {
        if (typeof one.prNumber === "number" && one.prNumber > 0) return one.prNumber !== prNumber;
        if (branch !== null && typeof one.branch === "string" && one.branch !== "") return one.branch !== branch;
        return true;
      }
      if (branch !== null) {
        if (typeof one.branch === "string" && one.branch !== "") return one.branch !== branch;
        return true;
      }
      if (sha !== null && typeof one.docBlobSha === "string" && one.docBlobSha !== "") return one.docBlobSha !== sha;
      return true;
    });
    return kept.length === entries.length ? entries : kept.length > 0 ? kept : undefined;
  } else {
    return entries;
  }
  const doomed = active.doomed;
  if (cachedSent !== undefined && (!doomed || (doomed.prNumber === null && doomed.sha === null))) return entries;
  const kept = entries.filter((one) => {
    if (!isSoleViewerDraftEntry(one, login)) return true;
    if (doomed?.prNumber != null && typeof one.prNumber === "number" && one.prNumber > 0) {
      return one.prNumber !== doomed.prNumber;
    }
    if (cachedSent === undefined && (doomed === null || doomed.prNumber === null)) {
      return false;
    }
    if (doomed?.sha != null && typeof one.docBlobSha === "string" && one.docBlobSha !== "") {
      return one.docBlobSha !== doomed.sha || one.docBlobSha === cachedSent;
    }
    return true;
  });
  return kept.length === entries.length ? entries : kept.length > 0 ? kept : undefined;
}

export function sanitizeDoomedReviewStatus(
  review: ReviewStatus,
  ctx: {
    info: DoomedDraftInfo | null;
    stayOn: boolean;
    viewer: string;
    hasOtherWriter: (prNumber: number | null) => boolean;
    present: boolean;
    cachedSent: string | undefined;
  },
): ReviewStatus {
  const { info, stayOn, viewer, hasOtherWriter, present, cachedSent } = ctx;
  if (!info || (info.kind === "live-delete" && !stayOn)) return review;
  if (review.reviewBranch === null && review.pr === null) return review;
  if ((review.reviewBranch !== null && isGroupBranch(review.reviewBranch)) || review.pr?.group || review.pr?.isDraft === false) {
    return review;
  }
  const author = review.pr?.authorLogin ?? null;
  const prNum = review.pr?.number ?? null;
  const soleOwn = (viewer === "" ? author === null : !isAnotherAuthor(author, viewer)) && !hasOtherWriter(prNum);
  if (!soleOwn) return review;
  if (info.doomed?.prNumber != null && prNum !== null) {
    return prNum === info.doomed.prNumber ? { reviewBranch: null, pr: null, ...(review.saver ? { saver: review.saver } : {}) } : review;
  }
  if ((info.doomed === null || info.doomed.prNumber === null) && (!present || cachedSent === undefined)) {
    return { reviewBranch: null, pr: null, ...(review.saver ? { saver: review.saver } : {}) };
  }
  return review;
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
  if (!reviewIsOpen(status) || !status.reviewBranch) return true;
  const viewer = deps.viewerLogin();
  const prNum = status.pr && status.pr.number > 0 ? status.pr.number : null;
  const soleOwn =
    !isGroupBranch(status.reviewBranch) &&
    !status.pr?.group &&
    status.pr?.isDraft !== false &&
    (viewer === "" ? (status.pr?.authorLogin ?? null) === null : !isAnotherAuthor(status.pr?.authorLogin ?? null, viewer)) &&
    !deps.model.hasOtherWriterInDraft(oldPath, prNum);
  if (!soleOwn) return true;
  const expectPr = prNum ?? undefined;
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

export async function closeOneDoomedDraft(
  path: string,
  deps: FlowDeps,
  hooks: DraftCloseHooks,
  options: { allowArmed?: boolean } = {},
): Promise<CloseDoomedResult> {
  const initialInfo = deps.model.doomedDraftFor(path);
  if (!initialInfo || deps.model.hasRepoFile(path)) {
    if (initialInfo) deps.model.finishDoomedDraft(path);
    return { outcome: "done", closed: false };
  }
  if (initialInfo.kind === "live-delete" && initialInfo.armed && options.allowArmed !== true) {
    return { outcome: "done", closed: false };
  }
  const doc = deps.documentFor(path);
  if (!doc) {
    deps.model.finishDoomedDraft(path);
    return { outcome: "done", closed: false };
  }
  if (initialInfo.kind === "superseded" && !initialInfo.recreated) {
    if (deps.vault.exists(path) || (await deps.readText(path)) !== null) {
      if (initialInfo.doomed === null) {
        deps.model.finishDoomedDraft(path);
        return { outcome: "done", closed: false };
      }
    }
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
  if (main.kind === "unreadable") return { outcome: "retry", closed: false };
  if (main.kind === "file" || !deps.model.doomedDraftFor(path) || isNewerRecreatedSave(null)) {
    deps.model.finishDoomedDraft(path);
    return { outcome: "done", closed: false };
  }
  const status = await deps.review.status(doc);
  if (status === null) return { outcome: "retry", closed: false };
  const activeInfo = deps.model.doomedDraftFor(path);
  if (!activeInfo || isNewerRecreatedSave(null)) {
    deps.model.finishDoomedDraft(path);
    return { outcome: "done", closed: false };
  }
  if (activeInfo.kind === "live-delete" && activeInfo.armed && options.allowArmed !== true) {
    return { outcome: "done", closed: false };
  }
  if (deps.vault.exists(path) && deps.model.isSavingDraft(path)) return { outcome: "retry", closed: false };
  if (!reviewIsOpen(status) || !status.reviewBranch) {
    if (!isNewerRecreatedSave(null)) {
      hooks.forgetMemory(path);
      deps.model.learnSent(path, null);
    }
    if (activeInfo.kind === "superseded") {
      if (!deps.vault.exists(path)) deps.model.retireDraftSource(path);
      else deps.model.finishDoomedDraft(path);
      return { outcome: "done", closed: false };
    }
    if (!deps.vault.exists(path) && activeInfo.liveFlushSha) {
      deps.model.markWaitingLiveFlush(path);
      deps.model.settledDelete(path);
      return { outcome: "done", closed: false };
    }
    deps.model.finishDoomedDraft(path);
    if (!deps.vault.exists(path)) deps.model.settledDelete(path);
    return { outcome: "done", closed: false };
  }
  const statusPrNum = status.pr && status.pr.number > 0 ? status.pr.number : null;
  if (deps.vault.exists(path) && statusPrNum !== null) {
    if (activeInfo.doomed?.prNumber != null) {
      if (statusPrNum !== activeInfo.doomed.prNumber) {
        deps.model.finishDoomedDraft(path);
        return { outcome: "done", closed: false };
      }
    } else {
      const currentSentTo = deps.model.sentTo(path);
      const currentSentSha = deps.model.sentSha(path);
      const sentMatchesPr = currentSentTo === `pr:${statusPrNum}`;
      const sentDiffersFromDoomed = activeInfo.doomed?.sha != null && currentSentSha !== null && currentSentSha !== activeInfo.doomed.sha;
      let prHoldsRecreatedDisk = false;
      if (!sentMatchesPr && !sentDiffersFromDoomed && activeInfo.doomed?.sha != null) {
        const rawBlob = deps.model.rawDraftBlobFor(path, statusPrNum);
        if (rawBlob !== null && rawBlob !== activeInfo.doomed.sha) {
          const diskText = await deps.readText(path);
          if (diskText !== null && gitBlobShaOfText(diskText) === rawBlob) prHoldsRecreatedDisk = true;
        }
      }
      if (sentMatchesPr || sentDiffersFromDoomed || prHoldsRecreatedDisk) {
        deps.model.finishDoomedDraft(path);
        return { outcome: "done", closed: false };
      }
    }
  }
  const viewer = deps.viewerLogin();
  const canAbandon =
    !isGroupBranch(status.reviewBranch) &&
    !status.pr?.group &&
    deps.model.groupOf(path) === undefined &&
    status.pr?.isDraft !== false &&
    (viewer === "" ? (status.pr?.authorLogin ?? null) === null : !isAnotherAuthor(status.pr?.authorLogin ?? null, viewer)) &&
    !deps.model.hasOtherWriterInDraft(path, statusPrNum);
  if (!canAbandon) {
    deps.model.finishDoomedDraft(path);
    return { outcome: "done", closed: false };
  }
  const expectPr = statusPrNum ?? undefined;
  const closedKey = expectPr !== undefined ? `pr:${expectPr}` : null;
  deps.model.updateDoomedDraft(path, { prNumber: statusPrNum, branch: status.reviewBranch, sha: beforeSentSha });
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
    if (closed.status === 0 || closed.status === 429 || closed.status >= 500) return { outcome: "retry", closed: false };
    deps.model.finishDoomedDraft(path);
    return { outcome: "done", closed: false };
  }
  hooks.clearUploaded();
  const existsNow = deps.vault.exists(path);
  const newerRecreated = isNewerRecreatedSave(closedKey);
  if (!newerRecreated) {
    const currentSentTo = deps.model.sentTo(path);
    const matchesClosedSent = !existsNow || currentSentTo === null || closedKey === null || currentSentTo === closedKey;
    if (matchesClosedSent) {
      hooks.forgetMemory(path);
      deps.model.learnSent(path, null);
    }
    if (!existsNow) deps.model.learn(path, { reviewBranch: null, pr: null });
  }
  deps.model.clearInFlightPath(path, status.reviewBranch, expectPr ?? null);
  deps.model.change({ kind: "gone", prNumbers: expectPr !== undefined ? [expectPr] : [], paths: existsNow ? [] : [doc.path], groupIds: [] });
  if (activeInfo.kind === "superseded" && !existsNow) {
    deps.model.retireDraftSource(path);
  } else {
    deps.model.finishDoomedDraft(path);
    if (!existsNow) deps.model.settledDelete(path);
  }
  return { outcome: "done", closed: closed.ok };
}
