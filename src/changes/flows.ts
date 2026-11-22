import { changesBetween } from "../disk/merge";
import { toLf } from "../disk/line-endings";
import { BURST_FROM } from "./burst";
import type { Shown } from "../disk/regions";
import { type DocumentRef, noteName } from "../mapping";
import type { MainFile } from "../auth/git-copy";
import { DELETED_WORDS } from "../deleted-words";
import { deletedAtOf, isLostAnswerResult, MAIN_MOVED, type ReviewApi, reviewIsOpen, type Reviewer, type StepResult } from "../review/review-api";
import {
  couldntDeleteTitle,
  deletedWords,
  type ItemOutcome,
  NOT_EVERYTHING_WENT_THROUGH,
  outcomeLine,
  outcomesDescription,
  canMoveBackToDraft,
  COULD_NOT_PUBLISH,
  COULDNT_FINISH,
  MOVE_BACK_FAILED,
  openCommentsWarning,
  setOpenCommentsWarning,
  MOVED_BACK,
  publishConfirm,
  BUSY_WORDS,
  LOST_ANSWER_DESCRIPTION,
  LOST_ANSWER_TITLE,
  type PrInfo,
  documentsIn,
  setPublishConfirm,
  submitReviewsWords,
  SUBMIT_FAILED,
  SUBMITTED_TITLE,
  submittedDescription,
  type CatchUpPreview,
  ASK_REVIEW_FAILED,
  type GroupPlan,
  groupPublishWords,
  unitKey,
  unitLabel,
  unitsWords,
  asksBeforeSeparate,
  newSeparateReviews,
  SEPARATE_ASK,
  ATTACHMENT_WORDS,
} from "../shared/review-flow";
import { ATTACHMENT_LATER, ATTACHMENT_NOT_SENT, ATTACHMENTS_SAID, attachmentName, toldOf } from "./attachment-memory";
import { carriesAttachments } from "./attachment-links";
import { isTextOfBytes } from "./blob-sha";
import { AutoCommitFlows, type FileRow, type SendOptions } from "./auto-commit";
import { type Behind, behindOf, type BranchHead, deletedOnGitHub, lastMatched, levelWith, sameAsVault, sendThroughBranch } from "./branch-send";
import { type CatchUpAsked, CatchUpFlows } from "./catch-up-flows";
import { attachmentAnswer, attachmentEntry, attachmentsToCarry, INLINE_ATTACHMENT_MAX_RAW, nameAttachments, type NamedAttachment, uploadOneAttachment } from "./attachment-send";
import { linksKeptWords, MoveFlows } from "./move-flows";
import { PublishFlows } from "./publish-flows";
import { ADD_REVIEWER_HERE, CHANGES_VIEW, DELETE_CONFIRM, DELETE_HELD_BACK, GONE_FROM_VAULT, partialReview, PUBLISHED_HERE, readOnlyRepo, REVIEW_REQUESTED_HERE, NOT_LIVE } from "../review/words";
import { type AutoCommit, type Carried, DELETED_ON_GITHUB, failure, isDenied, isLimited, mapLimit, MOVED_AGAIN, MOVED_ATTEMPTS, names, NO_CHANGE_TITLE, noChangeWords, REVIEW_UNCHECKED, REVIEW_UNCHECKED_TITLE, type Sent, transientFailure, UNREADABLE } from "./flow-helpers";
import { type GroupChange, GroupFlows, groupableRows } from "./group-flows";
import { Discard } from "./discard";
import { StopReview } from "./stop-review";
import { ApproveFlows } from "./approve";
import { MemberSync } from "./member-sync";
import { mergedWith } from "./note-merge";
import { inRepoEndings } from "./repo-endings";
import { SentMemory } from "./sent-memory";
import { writeCost } from "./write-cost";
import { CHECKING_WORDS } from "./words";
import { type ChangeRow, ChangesModel, type Doing } from "./model";
import type { SendHooks } from "../stay/types";
import { type ReadBackDeps, ReadBacks, reviewHolds } from "./read-back";
import type { AttachmentQuery, Dialogs, FlowDeps } from "./flow-deps";
import type { ChangesContext } from "../review/words";
import type { VaultFile } from "./vault-state";
import { readSince, type SinceView } from "./vault-since";
import { isAnotherAuthor } from "./review-owner";

const READS: ReadonlySet<string> = new Set(["status", "groups", "mergePreview", "catchUpPreview", "reviewers", "movesKnown"]);

export type Since = { kind: "same" } | { kind: "unreadable" } | { kind: "gone" } | { kind: "changes"; shown: Shown[] };

export type { AutoCommit };

const refusedAttachment = (result: StepResult): boolean => !result.ok && [400, 409, 413, 415, 422].includes(result.status);

const attachmentWhy = (why: "exists" | "changed"): string => (why === "changed" ? "it was changed by someone else in the unpublished changes, so yours was not sent. Yours is still in your vault" : "a different file with that name is already on GitHub");

function attachmentRefusal(result: StepResult): string {
  if (result.ok) return "";
  if (result.code === "file_changed") return attachmentWhy("changed");
  if (result.code === "file_exists") return attachmentWhy("exists");
  if (result.status === 413) return ATTACHMENT_WORDS.tooLarge;
  return "it is not a file specgit can store";
}

function attachmentNotSent(result: StepResult): { why: string; server?: true } {
  if (!result.ok && (result.code === "file_exists" || result.code === "file_changed" || result.status === 413)) return { why: attachmentRefusal(result) };
  return { why: failure(result as Extract<StepResult, { ok: false }>, ATTACHMENT_NOT_SENT), server: true };
}

export interface SubmitPlan {
  key: string;
  title: string;
  names: string;
  reviews: string | null;
  warning: string | null;
  pickReviewer: () => Promise<Reviewer | null>;
  submit: (reviewers: readonly Reviewer[]) => Promise<boolean>;
  stale: () => boolean;
}

export class ChangesFlows {
  private readonly uploaded = new Map<string, string | null>();

  private readonly deps: FlowDeps;
  private lostAnswers = 0;
  private refusals = 0;
  private unsureTold = false;

  private readonly meter = { writes: 0 };
  private readonly groups: GroupFlows;
  private readonly members: MemberSync;
  private readonly memory: SentMemory;
  private readonly catchUps: CatchUpFlows;
  private readonly publishing: PublishFlows;
  private readonly moving: MoveFlows;
  private readonly discarding: Discard;
  private readonly stopping: StopReview;
  private readonly approving: ApproveFlows;
  private readonly auto: AutoCommitFlows;

  constructor(deps: FlowDeps) {
    this.deps = { ...deps, review: this.watched(deps.review, deps.model) };
    this.memory = new SentMemory({ deps: this.deps, model: this.deps.model });
    this.catchUps = new CatchUpFlows({ deps: this.deps, model: this.deps.model, memory: this.memory, busy: (work, doing) => this.busy(work, doing), alert: (options) => this.alert(options), send: (row, options) => this.send(row, options) });
    this.moving = new MoveFlows(this.deps);
    this.publishing = new PublishFlows({ deps: this.deps, sendUnit: (row) => this.sendUnit(row), alert: (options) => this.alert(options), refusal: (result, doc, fallback) => this.refusal(result, doc, fallback) });
    this.discarding = new Discard({
      deps: this.deps,
      model: this.deps.model,
      memory: this.memory,
      busy: (work, doing) => this.busy(work, doing),
      alert: (options) => this.alert(options),
      readReviews: (files) => this.readReviews(files),
      readReviewsFromMap: (files) => this.readReviewsFromMap(files),
      inReviewOfSomeoneElse: (row) => this.inReviewOfSomeoneElse(row),
      closeReviews: (rows, step, expectPr) => this.closeReviews(rows, step, expectPr),
    });
    this.stopping = new StopReview({
      deps: this.deps,
      model: this.deps.model,
      busy: (work, doing) => this.busy(work, doing),
      alert: (options) => this.alert(options),
      readReviews: (files) => this.readReviews(files),
      closeReviews: (rows, step) => this.closeReviews(rows, step),
      forget: (path) => {
        this.uploaded.clear();
        this.memory.forget(path);
      },
    });
    this.approving = new ApproveFlows({
      deps: this.deps,
      readUnits: (asked) => this.readUnits(asked),
      filesOf: (unit) => this.filesOf(unit),
      busy: (work, doing) => this.busy(work, doing),
      alert: (options) => this.alert(options),
      refusal: (result, doc, fallback) => this.refusal(result, doc, fallback),
    });
    this.members = new MemberSync({ deps: this.deps, backs: this.backs, memory: this.memory, send: (row) => this.send(row, { afresh: true }) });
    this.groups = new GroupFlows({
      deps: this.deps,
      model: this.deps.model,
      backs: this.backs,
      meter: this.meter,
      busy: (work, doing) => this.busy(work, doing),
      alert: (options) => this.alert(options),
      syncAll: (rows, group) => this.members.syncAll(rows, group),
      memory: this.memory,
      takeBranchText: (row) => this.members.takeBranchText(row),
    });
    this.auto = new AutoCommitFlows({
      deps: this.deps,
      model: this.deps.model,
      backs: this.backs,
      memory: this.memory,
      meter: this.meter,
      goneAt: this.goneAt,
      sendOnce: (row, options) => this.sendOnce(row, options),
      sendAttachmentsAlone: (row, deps) => this.sendAttachmentsAlone(row, deps, false, { onlyMine: true, branch: row.review?.reviewBranch ?? null }),
    });
  }

  private watched(review: ReviewApi, model: ChangesModel): ReviewApi {
    const lost = (): void => void (this.lostAnswers += 1);
    const refused = (): void => void (this.refusals += 1);
    const meter = this.meter;
    return new Proxy(review, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const cost = writeCost(String(key), args);
          meter.writes += cost;
          const result: unknown = await (value as (...a: unknown[]) => unknown).apply(target, args);
          if (String(key) === "moves" && result !== null && typeof result === "object") {
            const said = ((result as { body?: Record<string, unknown> | null }).body ?? {}).writes;
            if (typeof said === "number") meter.writes += said - cost;
          }
          if (result !== null && typeof result === "object" && "ok" in result) {
            if (isLostAnswerResult(result as StepResult)) lost();
            else if ((result as StepResult).ok === false) refused();
            else if (!READS.has(String(key))) model.wroteOk();
          }
          return result;
        };
      },
    });
  }

  private async alert(options: Parameters<Dialogs["alert"]>[0]): Promise<void> {
    const during = this.model.state().busy;
    if (during) this.model.setBusy(false);
    if (during && this.lostAnswers > 0) {
      this.unsureTold = true;
      this.deps.dialogs.toast(LOST_ANSWER_TITLE, LOST_ANSWER_DESCRIPTION);
      void this.model.refresh();
      if (this.refusals === 0) return;
    }
    return this.deps.dialogs.alert(options);
  }

  private refusal(result: Extract<StepResult, { ok: false }>, doc: DocumentRef, fallback: string): string {
    if (isLimited(result)) return failure(result, fallback);
    if (result.status === 401) return NOT_LIVE.revoked;
    if (this.model.readOnly()) return readOnlyRepo(doc.repo);
    return failure(result, fallback);
  }

  private get model(): ChangesModel {
    return this.deps.model;
  }

  private async busy<T>(work: () => Promise<T>, doing: Doing): Promise<T> {
    this.lostAnswers = 0;
    this.refusals = 0;
    this.unsureTold = false;
    this.model.setBusy(true, doing);
    try {
      return await work();
    } finally {
      if (this.lostAnswers > 0 && !this.unsureTold) this.deps.dialogs.toast(LOST_ANSWER_TITLE, LOST_ANSWER_DESCRIPTION);
      this.model.setBusy(false);
      void this.model.refresh();
    }
  }

  private async send(row: ChangeRow, options: { toReview?: boolean; afresh?: boolean } = {}): Promise<Sent> {
    let carried: Carried | undefined;
    for (let attempt = 1; ; attempt++) {
      const sent = await this.sendOnce(row, { ...options, carried });
      if (sent.ok || "held" in sent || !sent.moved) return sent;
      if (attempt >= MOVED_ATTEMPTS) return { ok: false, message: MOVED_AGAIN(noteName(row.change.path)) };
      carried = sent.carried;
    }
  }

  private async sendOnce(row: ChangeRow, options: SendOptions = {}): Promise<Sent> {
    const { change, doc } = row;
    const { deps, memory } = options.auto ?? { deps: this.deps, memory: this.memory };
    const name = noteName(change.path);
    if (options.quiet && this.model.groupOf(change.path) && !options.viaGroup) return { ok: false, held: true };
    if (change.kind === "deleted") return { ok: true, expectMain: null };
    if (change.kind === "renamed" && change.from && !(row.entry && (await this.reviewHoldsRename(row, change.from)))) return options.toReview ? { ok: false, message: COULDNT_FINISH } : this.sendRename(row, change.from, options.quiet === true);
    const text = await deps.readText(change.path);
    if (text === null) return { ok: false, message: COULDNT_FINISH };
    const main: MainFile = options.toReview ? { kind: "absent" } : await deps.gitFile(doc);
    if (main.kind === "unreadable") return { ok: false, unreadable: true, message: UNREADABLE(name) };
    if (!options.toReview && deletedOnGitHub(row, main)) return options.quiet ? { ok: false, held: true } : { ok: false, message: DELETED_ON_GITHUB(name) };
    if (options.quiet && (options.toReview || options.edit)) {
      if (options.edit && (main.kind !== "file" || !lastMatched(row, main))) return { ok: false, held: true };
    } else if (options.quiet) {
      if (main.kind === "file") return { ok: false, held: true };
      const existing = await deps.review.status(doc);
      if (existing === null) return { ok: false, unreadable: true, message: UNREADABLE(name) };
      if (reviewIsOpen(existing)) return this.alreadyThere(change.path, doc, existing, text, memory);
    }
    const branch = options.quiet ? options.branch : (row.theirs?.branch ?? row.review?.reviewBranch ?? undefined);
    const found = options.found ?? (branch ? await deps.branchFile(doc, branch) : undefined);
    if (found?.kind === "unreadable") return { ok: false, unreadable: true, message: UNREADABLE(name) };
    const first = found?.kind === "file" ? found : undefined;
    const prior = options.carried?.text === text ? options.carried : undefined;
    const moved = main.kind === "file" && !lastMatched(row, main);
    let throughDraft = false;
    if (moved && first !== undefined && prior === undefined) {
      if (sameAsVault(change.path, first.text, text)) throughDraft = true;
      else {
        const sent = await memory.lastSent(row, first, branch);
        if (sent === "unreadable") return { ok: false, unreadable: true, message: UNREADABLE(name) };
        throughDraft = sent !== "never";
      }
    }
    const merging = moved && !throughDraft;
    let mine = text;
    if (main.kind === "file" && merging) {
      const made = prior ? (prior.main === main.text ? prior.body : await mergedWith(deps, row, prior.body, main.text, prior.main)) : await mergedWith(deps, row, text, main.text);
      if (made === null) return { ok: false, held: true };
      mine = made;
    }
    return sendThroughBranch({ deps: deps, memory: memory }, row, mine, first, (body, there, levelledWith) => this.saveToReview(row, { text, body, there, main, merged: merging, levelledWith, options }), {
      branch,
      ...(merging && prior?.branch !== undefined ? { held: prior.branch } : {}),
      level: options.toReview ? async (mine) => levelWith(deps, row, mine, await deps.gitFile(doc)) : "level",
    });
  }

  private async nameAttachments(row: FileRow, deps: FlowDeps, query?: AttachmentQuery): Promise<{ named: Array<NamedAttachment & { key: string }>; problems: Array<{ name: string; why: string; server?: true }> }> {
    const { change, doc } = row;
    const named: Array<NamedAttachment & { key: string }> = [];
    const problems: Array<{ name: string; why: string; server?: true }> = [];
    if (!carriesAttachments(change.path)) return { named, problems };
    const used = await deps.attachments(change.path, query);
    deps.attachmentTold?.(change.path, toldOf(used));
    for (const attachment of used) {
      if ("skipped" in attachment) continue;
      const base64Of = async (): Promise<string> => (typeof attachment.base64 === "string" ? attachment.base64 : attachment.base64());
      const sha = attachment.sha ?? (await nameAttachments([{ repoPath: attachment.repoPath, base64: await base64Of() }]))[0]!.sha;
      const key = `${doc.repo}\n${doc.path}\n${attachment.repoPath}\n${sha}`;
      if (this.uploaded.get(key) === (row.review?.reviewBranch ?? null)) continue;
      if (attachment.sha !== undefined && attachment.size !== undefined && attachment.size > INLINE_ATTACHMENT_MAX_RAW) {
        named.push({ repoPath: attachment.repoPath, sha, size: attachment.size, key, ...(attachment.binary ? { binary: attachment.binary } : {}), ...(attachment.expectSha === undefined ? {} : { expectSha: attachment.expectSha }) });
        continue;
      }
      const base64 = await base64Of();
      const size = attachment.size ?? Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
      named.push({ repoPath: attachment.repoPath, base64, sha, size, key, ...(attachment.binary ? { binary: attachment.binary } : {}), ...(attachment.expectSha === undefined ? {} : { expectSha: attachment.expectSha }) });
    }
    return { named, problems };
  }

  private async sendAttachmentsAlone(row: FileRow, deps: FlowDeps, onlyDue = false, query?: AttachmentQuery): Promise<Sent | null> {
    const picked = await this.nameAttachments(row, deps, query);
    const { problems } = picked;
    const named = onlyDue ? picked.named.filter((attachment) => deps.attachmentHeld?.(attachment.repoPath, attachment.sha) !== true) : picked.named;
    for (const attachment of named) {
      const { result: uploaded, sha } = await uploadOneAttachment(deps.review, row.doc, attachment);
      if (!uploaded.ok) {
        const deleted = deletedAtOf(uploaded);
        if (deleted !== null) return this.gone(row.change.path, deleted);
        if (refusedAttachment(uploaded)) {
          problems.push({ name: attachmentName(attachment.repoPath), why: attachmentRefusal(uploaded) });
          continue;
        }
        const transient = transientFailure(uploaded, COULDNT_FINISH);
        if (transient !== null) return transient;
        return { ok: false, message: failure(uploaded, COULDNT_FINISH) };
      }
      const at = (uploaded.body as { reviewBranch?: unknown }).reviewBranch;
      this.uploaded.set(`${row.doc.repo}\n${row.doc.path}\n${attachment.repoPath}\n${sha}`, typeof at === "string" ? at : (row.review?.reviewBranch ?? null));
      deps.attachmentAgreed?.(attachment.repoPath, sha);
    }
    deps.attachmentProblems?.(row.change.path, problems);
    return null;
  }

  async sendLiveFiles(path: string): Promise<void> {
    const doc = this.deps.documentFor(path);
    if (doc === null) return;
    await this.sendAttachmentsAlone({ doc, change: { path }, review: null }, this.deps, true, { onlyMine: true });
  }

  private async saveToReview(row: ChangeRow, step: { text: string; body: string; there: BranchHead | undefined; main: MainFile; merged: boolean; levelledWith: string | null; options: SendOptions }): Promise<Sent | Behind> {
    const { change, doc } = row;
    const { deps, memory } = step.options.auto ?? { deps: this.deps, memory: this.memory };
    const { text, body, there, main, merged, levelledWith, options } = step;
    const expectMain = main.kind === "file" ? main.sha : null;
    const lenient = step.options.auto !== undefined;
    const automatic = lenient || step.options.quiet === true;
    const baselines: string[] = [];
    if (main.kind === "file") baselines.push(main.text);
    if (there !== undefined) baselines.push(there.text);
    const branch = there !== undefined ? null : (options.branch ?? row.review?.reviewBranch ?? null);
    const { named, problems } = await this.nameAttachments(row, deps, automatic ? { onlyMine: true, baselines, ...(branch !== null ? { branch } : {}) } : undefined);
    const probe = change.kind !== "new" || Boolean(row.review?.reviewBranch);
    const carried = probe ? new Set<NamedAttachment>() : attachmentsToCarry(named);
    const like = main.kind === "file" ? main.text : options.toReview ? there?.text : undefined;
    const outgoing = like === undefined ? body : inRepoEndings(body, like);
    const createOver = lenient ? null : (this.deps.deletedAt?.(change.path) ?? null);
    const saved = await this.backs.save(row.doc, outgoing, await deps.review.save(doc, outgoing, options.toReview ? undefined : expectMain, { toExistingReview: options.toReview === true, ...(createOver === null ? {} : { createOver }), ...(options.afresh ? { afresh: true } : {}), ...(row.review?.reviewBranch ? { hasReview: true } : {}), ...(there ? { expectBranch: there.sha } : {}), ...(named.length > 0 ? { attachments: named.map((attachment) => attachmentEntry(attachment, carried.has(attachment))), ...(lenient ? { attachmentsKeepGoing: true as const } : {}) } : {}) }));
    if (saved.ok && createOver !== null) this.deps.restored?.(change.path);
    if (saved.ok) {
      const savedBranch = typeof saved.body.reviewBranch === "string" ? saved.body.reviewBranch : (row.review?.reviewBranch ?? null);
      if (named.length > 0) {
        const sent = await this.sendMissingAttachments(row, named, saved.body, savedBranch, { expectMain, outgoing, options }, deps, problems, lenient);
        if (sent !== null) return sent;
      }
      if (lenient) deps.attachmentProblems?.(change.path, problems);
      if (saved.body.unchanged === true && expectMain !== null && saved.body.contentSha === expectMain && body === text) {
        const ours = main.kind === "file" && sameAsVault(change.path, main.text, text);
        if (isTextOfBytes(text, change.sha)) deps.model.learnSame(change.path, change.sha, expectMain, ours ? undefined : "server");
        return { ok: true, expectMain, unchanged: true };
      }
      const inVault = await memory.accepted(change.path, text, outgoing, merged && main.kind === "file" && !options.toReview ? main.sha : levelledWith, saved.body);
      const said = !lenient && problems.length > 0 ? { attachments: ATTACHMENTS_SAID(problems) } : {};
      return inVault ? { ok: true, expectMain, ...said } : { ok: true, expectMain, inVault: false, ...said };
    }
    const deleted = deletedAtOf(saved);
    if (deleted !== null) return this.gone(change.path, deleted);
    const transient = transientFailure(saved, COULDNT_FINISH);
    if (transient !== null) return transient;
    if (isDenied(saved)) return { ok: false, message: this.refusal(saved, doc, COULDNT_FINISH), decide: true };
    const behind = behindOf(saved, COULDNT_FINISH);
    if (behind) return behind;
    if (saved.code !== MAIN_MOVED) return { ok: false, message: failure(saved, COULDNT_FINISH) };
    return { ok: false, message: failure(saved, COULDNT_FINISH), moved: true, ...(merged && main.kind === "file" ? { carried: { text, body, main: main.text, ...(there ? { branch: there.text } : {}) } } : {}) };
  }

  private async sendMissingAttachments(
    row: ChangeRow,
    named: ReadonlyArray<NamedAttachment & { key: string }>,
    answer: Record<string, unknown>,
    branch: string | null,
    again: { expectMain: string | null; outgoing: string; options: { toReview?: boolean; afresh?: boolean } },
    deps: FlowDeps,
    problems: Array<{ name: string; why: string; server?: true }>,
    lenient: boolean,
  ): Promise<Sent | null> {
    const said = attachmentAnswer(answer);
    const done = new Set<string>();
    const sent = (attachment: NamedAttachment & { key: string }, at: string | null, agreedSha = attachment.sha): void => {
      done.add(attachment.repoPath);
      this.uploaded.set(`${row.doc.repo}\n${row.doc.path}\n${attachment.repoPath}\n${agreedSha}`, at);
      deps.attachmentAgreed?.(attachment.repoPath, agreedSha);
    };
    const refused = (attachment: NamedAttachment, why: "exists" | "changed"): void => {
      done.add(attachment.repoPath);
      problems.push({ name: attachmentName(attachment.repoPath), why: attachmentWhy(why) });
    };
    const settle = (reply: ReturnType<typeof attachmentAnswer>, attachments: ReadonlyArray<NamedAttachment & { key: string }>): void => {
      if (!reply) return;
      for (const attachment of attachments) {
        if (reply.written.has(attachment.repoPath) || reply.held.has(attachment.repoPath)) sent(attachment, branch);
        else if (reply.refused.has(attachment.repoPath)) refused(attachment, reply.refused.get(attachment.repoPath)!);
      }
    };
    settle(said, named);
    let needed = named.filter((attachment) => !done.has(attachment.repoPath));
    if (needed.length === 0) return null;
    const doc = row.doc;
    if (said) {
      const carry = attachmentsToCarry(needed);
      if (carry.size > 0) {
        const second = await deps.review.save(doc, again.outgoing, undefined, { toExistingReview: true, hasReview: true, ...(again.options.afresh ? { afresh: true } : {}), ...(typeof answer.contentSha === "string" ? { expectBranch: answer.contentSha } : {}), attachments: needed.map((attachment) => attachmentEntry(attachment, carry.has(attachment))), ...(lenient ? { attachmentsKeepGoing: true as const } : {}) });
        if (!second.ok) {
          const why = lenient ? { why: ATTACHMENT_LATER } : attachmentNotSent(second);
          for (const attachment of needed) problems.push({ name: attachmentName(attachment.repoPath), ...why });
          return null;
        }
        settle(attachmentAnswer(second.body), needed);
        needed = needed.filter((attachment) => !done.has(attachment.repoPath));
      }
    }
    for (const attachment of needed) {
      const { result: uploaded, sha } = await uploadOneAttachment(deps.review, doc, attachment);
      if (!uploaded.ok) {
        if (lenient && refusedAttachment(uploaded)) {
          problems.push({ name: attachmentName(attachment.repoPath), why: attachmentRefusal(uploaded) });
          continue;
        }
        problems.push({ name: attachmentName(attachment.repoPath), ...(lenient ? { why: ATTACHMENT_LATER } : attachmentNotSent(uploaded)) });
        continue;
      }
      sent(attachment, typeof (uploaded.body as { reviewBranch?: unknown }).reviewBranch === "string" ? (uploaded.body as { reviewBranch: string }).reviewBranch : branch, sha);
    }
    return null;
  }

  private async alreadyThere(path: string, doc: DocumentRef, existing: NonNullable<Awaited<ReturnType<ReviewApi["status"]>>>, text: string, memory: SentMemory = this.memory): Promise<Sent> {
    const holds = await reviewHolds(this.back, doc, text, existing);
    if (holds === null) return { ok: false, unreadable: true, message: UNREADABLE(noteName(doc.path)) };
    if (!holds) return { ok: false, held: true };
    await memory.accepted(path, text, text, null, { pr: existing.pr });
    return { ok: true, expectMain: null };
  }

  private get back(): ReadBackDeps {
    return { review: this.deps.review, branchFile: (doc, branch) => this.deps.branchFile(doc, branch), pause: (ms) => this.deps.pause?.(ms) ?? new Promise((done) => window.setTimeout(done, ms)) };
  }

  private readonly backs = new ReadBacks(() => this.back, () => void (this.lostAnswers -= 1));

  private async reviewHoldsRename(row: ChangeRow, fromPath: string): Promise<boolean> {
    const branch = row.review?.reviewBranch;
    const from = this.deps.documentFor(fromPath);
    if (!branch || !from) return false;
    const [old, there] = await Promise.all([this.deps.branchFile(from, branch), this.deps.branchFile(row.doc, branch)]);
    return old.kind === "absent" && there.kind === "file";
  }

  private async sendRename(row: ChangeRow, fromPath: string, quiet = false): Promise<Sent> {
    const { change, doc } = row;
    if (quiet) {
      const text = await this.deps.readText(change.path);
      const existing = text === null ? null : await this.deps.review.status(doc);
      if (existing !== null && text !== null && reviewIsOpen(existing)) return this.alreadyThere(change.path, doc, existing, text);
    }
    const from = this.deps.documentFor(fromPath);
    if (!from) return { ok: false, message: COULDNT_FINISH };
    const [old, target] = await Promise.all([this.deps.gitFile(from), this.deps.gitFile(doc)]);
    if (old.kind === "unreadable" || target.kind === "unreadable") return { ok: false, unreadable: true, message: UNREADABLE(noteName(fromPath)) };
    if (old.kind === "absent") return { ok: false, decide: true, message: `${noteName(fromPath)} is no longer on GitHub, so it was not renamed.` };
    if (old.sha !== change.sha) return { ok: false, decide: true, message: `${noteName(fromPath)} changed on GitHub, so it wasn't renamed. Nothing was lost.` };
    if (target.kind === "file") return { ok: false, decide: true, message: `${noteName(change.path)} already exists on GitHub, so ${noteName(fromPath)} wasn't renamed to it.` };
    const renamed = await this.deps.review.rename(from, doc.path, old.sha);
    if (renamed.ok) {
      await this.memory.accepted(change.path, old.text, old.text, null, renamed.body);
      return { ok: true, expectMain: null };
    }
    const transient = transientFailure(renamed, COULDNT_FINISH);
    if (transient !== null) return transient;
    if (isDenied(renamed)) return { ok: false, message: this.refusal(renamed, doc, COULDNT_FINISH), decide: true };
    return renamed.code === MAIN_MOVED ? { ok: false, message: failure(renamed, COULDNT_FINISH), moved: true } : { ok: false, message: failure(renamed, COULDNT_FINISH) };
  }

  private readonly goneAt = new Map<string, number>();

  private gone(path: string, at: number): Sent {
    this.goneAt.set(path, at);
    this.deps.deleted?.(path, at);
    return { ok: false, message: DELETED_WORDS.title, deleted: at };
  }

  autoCommit(row: ChangeRow, isCurrent: () => boolean, hooks?: SendHooks): Promise<{ result: AutoCommit; writes: number; deletedAt?: number; retryAfterMs?: number }> {
    return this.auto.autoCommit(row, isCurrent, hooks);
  }

  autoAttachments(row: ChangeRow, isCurrent: () => boolean, hooks: SendHooks): Promise<{ result: "done" | "later" | "limited"; writes: number; retryAfterMs?: number }> {
    return this.auto.autoAttachments(row, isCurrent, hooks);
  }

  forgetSent(path: string): void {
    this.memory.forget(path);
  }

  private expand(rows: readonly ChangeRow[]): ChangeRow[] {
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const unit = row.group ? row : (this.model.groupOf(row.change.path) ?? row);
      const key = unit.group ? `g:${unit.group.id}` : unit.change.path;
      if (seen.has(key)) return [];
      seen.add(key);
      return [unit];
    });
  }

  private filesOf(unit: ChangeRow): ChangeRow[] {
    return unit.group ? unit.group.members : [unit];
  }

  private async readUnits(asked: readonly ChangeRow[]): Promise<ChangeRow[]> {
    const units = this.expand(asked);
    const read = await this.model.read(units.flatMap((unit) => (unit.group && unit.group.members.length > BURST_FROM ? unit.group.members.slice(0, 1) : this.filesOf(unit))));
    const unchecked = read.filter((row) => row.unchecked === true);
    if (unchecked.length > 0) {
      await this.alert({ title: REVIEW_UNCHECKED_TITLE, description: REVIEW_UNCHECKED(unchecked.map((row) => noteName(row.change.path))) });
      return [];
    }
    const by = new Map(read.map((row) => [row.change.path, row]));
    return units.map((unit) => (unit.group ? (this.model.group(unit.group.id) ?? unit) : (by.get(unit.change.path) ?? unit)));
  }

  private async sendUnit(unit: ChangeRow): Promise<Sent> {
    if (!unit.group) return this.send(unit, { afresh: true });
    const synced = await this.members.syncAll(unit.group.members, unit.unit.name);
    if (!synced.ok) return synced;
    const main = await this.deps.gitFile(unit.doc);
    if (main.kind === "unreadable") return { ok: false, message: UNREADABLE(noteName(unit.change.path)) };
    return { ok: true, expectMain: main.kind === "file" ? main.sha : null };
  }

  submitPlan(asked: readonly ChangeRow[]): SubmitPlan {
    const rows = this.expand(asked);
    return {
      key: rows.map((row) => unitKey(row.unit)).join("\n"),
      title: `Submit ${unitsWords(rows.map((row) => row.unit))} for review`,
      names: rows.map((row) => unitLabel(row.unit, () => noteName(row.change.path))).join(", "),
      reviews: submitReviewsWords(rows.length),
      warning: this.commentsWarning(rows.flatMap((row) => this.filesOf(row))),
      pickReviewer: async () => this.deps.dialogs.pickReviewer(await this.deps.candidates(rows[0]!.doc), ADD_REVIEWER_HERE),
      submit: (reviewers) => this.submit(rows, reviewers.map((one) => one.login)),
      stale: () => rows.every((unit) => {
        const now = unit.group ? this.model.group(unit.group.id) : this.model.row(unit.change.path);
        return !now || !now.unit.isDraft;
      }),
    };
  }

  private commentsWarning(rows: readonly ChangeRow[]): string | null {
    const open = (row: ChangeRow): number => this.deps.openComments?.(row.change.path) ?? row.entry?.openComments ?? 0;
    if (rows.length === 1) return openCommentsWarning(open(rows[0]!), "note");
    return setOpenCommentsWarning(rows.map((row) => ({ name: noteName(row.change.path), openComments: open(row) })));
  }

  async changesSinceMain(row: ChangeRow): Promise<Since> {
    const [main, mine] = await Promise.all([row.change.kind === "new" ? Promise.resolve("") : this.deps.gitCopy(row.doc), this.deps.readText(row.change.path)]);
    if (mine === null) return { kind: "gone" };
    if (main === null) return { kind: "unreadable" };
    const shown = changesBetween(toLf(main), toLf(mine));
    return shown === null ? { kind: "same" } : { kind: "changes", shown };
  }

  async showRowChanges(row: ChangeRow): Promise<void> {
    const since = await this.changesSinceMain(row);
    if (since.kind !== "changes") return this.deps.dialogs.toast(since.kind === "same" ? CHANGES_VIEW.none : since.kind === "gone" ? GONE_FROM_VAULT : CHANGES_VIEW.couldNotRead);
    this.deps.showChanges(since.shown, { kind: "yours", name: noteName(row.change.path) });
  }

  async showVaultView(file: VaultFile, view: SinceView): Promise<void> {
    if (view === "yours") {
      const row = this.model.row(file.path);
      if (row) await this.showRowChanges(row);
      return;
    }
    const doc = this.deps.documentFor(file.path);
    if (!doc) return;
    const read = await readSince(this.deps, doc, file, view);
    if (read.kind === "said") return this.deps.dialogs.toast(read.words);
    this.deps.showChanges(read.shown, read.context);
  }

  private async askSeparate(fresh: readonly ChangeRow[], learned = false, mayRename = false): Promise<"separate" | "group" | "cancel"> {
    if (!asksBeforeSeparate(newSeparateReviews(fresh.map(() => ({ hasReview: false }))))) return "separate";
    const state = this.model.state();
    const groupable = fresh.filter((row) => row.change.kind !== "renamed" && row.change.kind !== "deleted");
    const canGroup = state.groupsOn && !state.groupsLocked && groupable.length >= 2;
    const renamed = fresh.filter((row) => row.change.kind === "renamed").length;
    const words = { title: SEPARATE_ASK.title(fresh.length, mayRename && renamed > 0), description: SEPARATE_ASK.description(canGroup, renamed, groupable.length, learned, mayRename) };
    if (!canGroup) return (await this.deps.dialogs.confirm({ ...words, confirmLabel: SEPARATE_ASK.separate })) ? "separate" : "cancel";
    const answer = await this.deps.dialogs.choose({ ...words, confirmLabel: SEPARATE_ASK.group, cancelLabel: SEPARATE_ASK.separate });
    return answer === null ? "cancel" : answer ? "group" : "separate";
  }

  private freshOf(rows: readonly ChangeRow[]): ChangeRow[] {
    return rows.filter((row) => !row.group && row.change.kind !== "deleted" && !(row.review?.reviewBranch || row.review?.pr || row.entry));
  }

  private async groupThem(fresh: readonly ChangeRow[]): Promise<ChangeRow | null> {
    const made = await this.groups.createGroup(groupableRows(fresh));
    if (!made.ok) return null;
    await this.model.refresh();
    return this.model.state().groups.find((row) => row.group?.id === made.id) ?? null;
  }

  async submit(asked: readonly ChangeRow[], reviewers: readonly string[], options: { asked?: true } = {}): Promise<boolean> {
    const freshAsked = options.asked ? [] : this.freshOf(asked);
    if (asksBeforeSeparate(freshAsked.length)) {
      const fresh = freshAsked;
      const choice = await this.askSeparate(fresh);
      if (choice === "cancel") return false;
      if (choice === "group") {
        const grouped = await this.groupThem(fresh);
        if (!grouped) return false;
        const left = asked.filter((row) => !fresh.includes(row) || row.change.kind === "renamed");
        return this.submit([grouped, ...left], reviewers, { asked: true });
      }
    }
    return this.busy(async () => {
      const rows = await this.readUnits(asked);
      if (rows.length === 0) return false;
      const problems: string[] = [];
      const wereAsked: string[] = [];
      const refused: string[] = [];
      let held = false;
      const unchanged: string[] = [];
      const attachmentNotes: string[] = [];
      for (const row of rows) {
        const sent = await this.sendUnit(row);
        if ("held" in sent) {
          held = true;
          break;
        }
        if (!sent.ok) {
          problems.push(`${unitLabel(row.unit, () => noteName(row.change.path))}: ${sent.message}`);
          continue;
        }
        if (sent.attachments) attachmentNotes.push(sent.attachments);
        if (sent.unchanged && !row.group) {
          unchanged.push(noteName(row.change.path));
          continue;
        }
        const result = await this.backs.submit(row.doc, reviewers.length ? await this.deps.review.requestReview(row.doc, reviewers) : await this.deps.review.share(row.doc));
        if (!result.ok && result.code === "reviewer_rejected" && reviewers.length) {
          const each = await this.askEach(row, reviewers);
          if (each) {
            wereAsked.push(...each.asked);
            refused.push(...each.refused);
            continue;
          }
        }
        if (!result.ok) problems.push(`${unitLabel(row.unit, () => noteName(row.change.path))}: ${failure(result, reviewers.length ? ASK_REVIEW_FAILED : SUBMIT_FAILED)}`);
        else this.learnFrom(row, result.body);
      }
      const partial = refused.length ? partialReview([...new Set(wereAsked)], [...new Set(refused)]) : null;
      const unchangedWords = noChangeWords(unchanged, unchanged.length === rows.length);
      if (problems.length) {
        await this.alert({ title: reviewers.length ? ASK_REVIEW_FAILED : SUBMIT_FAILED, description: [problems.join("\n"), partial && `${partial.title}. ${partial.description}`, unchangedWords].filter(Boolean).join("\n") });
        return false;
      }
      if (partial) await this.alert({ title: partial.title, description: [partial.description, ...attachmentNotes].join(" ") });
      if (held) return false;
      if (rows.length > 0 && unchanged.length === rows.length) {
        await this.alert({ title: NO_CHANGE_TITLE, description: unchangedWords! });
        return false;
      }
      if (partial) return true;
      this.deps.dialogs.toast(SUBMITTED_TITLE, [submittedDescription(reviewers), unchangedWords, ...attachmentNotes].filter(Boolean).join(" ") || undefined);
      return true;
    }, { words: BUSY_WORDS.submit, paths: asked.map((row) => row.change.path), kind: "submit" });
  }

  private async askEach(row: ChangeRow, reviewers: readonly string[]): Promise<{ asked: string[]; refused: string[] } | null> {
    const asked: string[] = [];
    const refused: string[] = [];
    for (const login of reviewers) {
      const one = await this.deps.review.requestReview(row.doc, [login]);
      if (one.ok) {
        asked.push(login);
        this.learnFrom(row, one.body);
      } else if (one.code === "reviewer_rejected") refused.push(login);
      else return null;
    }
    if (asked.length === 0) {
      const shared = await this.deps.review.share(row.doc);
      if (!shared.ok) return null;
      this.learnFrom(row, shared.body);
    }
    return { asked, refused };
  }

  private learnFrom(row: ChangeRow, body: Record<string, unknown>): void {
    const pr = body.pr as (PrInfo & { headRef?: unknown }) | undefined;
    if (!pr || typeof pr.number !== "number" || typeof pr.state !== "string" || pr.isDraft !== false) return;
    this.model.learn(row.change.path, { reviewBranch: typeof pr.headRef === "string" ? pr.headRef : (row.review?.reviewBranch ?? null), pr });
    if (row.group) this.model.change({ kind: "draft", paths: [], groupIds: [row.group.id], isDraft: false });
  }

  async addReviewer(asked: readonly ChangeRow[]): Promise<void> {
    const rows = await this.readUnits(asked);
    if (rows.length === 0) return;
    const picked = await this.deps.dialogs.pickReviewer(await this.deps.candidates(rows[0]!.doc), ADD_REVIEWER_HERE);
    if (!picked) return;
    const { login } = picked;
    await this.busy(async () => {
      for (const row of rows) {
        const result = await this.deps.review.requestReview(row.doc, [login]);
        if (!result.ok) return this.alert({ title: ASK_REVIEW_FAILED, description: failure(result, COULDNT_FINISH) });
      }
      const said = REVIEW_REQUESTED_HERE(login);
      this.deps.dialogs.toast(said.title, said.description);
    }, { words: BUSY_WORDS["ask-review"], paths: rows.map((row) => row.change.path) });
  }

  async moveBackToDraft(asked: readonly ChangeRow[]): Promise<void> {
    const rows = await this.readUnits(asked);
    if (rows.length === 0) return;
    await this.busy(async () => {
      for (const row of rows) {
        const result = await this.deps.review.unsubmit(row.doc);
        if (!result.ok) return this.alert({ title: MOVE_BACK_FAILED, description: failure(result, MOVE_BACK_FAILED) });
        this.learnDraft(row);
      }
      this.deps.dialogs.toast(MOVED_BACK.title, MOVED_BACK.description);
    }, { words: BUSY_WORDS.unsubmit, paths: rows.flatMap((row) => this.filesOf(row).map((file) => file.change.path)) });
  }

  private learnDraft(unit: ChangeRow): void {
    if (unit.group) this.model.change({ kind: "draft", paths: [], groupIds: [unit.group.id], isDraft: true });
    for (const file of this.filesOf(unit)) {
      const pr = file.review?.pr;
      if (pr) this.model.learn(file.change.path, { reviewBranch: file.review?.reviewBranch ?? null, pr: { ...pr, isDraft: true, state: "draft" } });
    }
  }

  showChanges(shown: Shown[], context: ChangesContext): void {
    this.deps.showChanges(shown, context);
  }

  canMoveBack(row: ChangeRow): boolean {
    return row.entry !== null && canMoveBackToDraft(row.entry, this.deps.viewerLogin());
  }

  private async readToPublish(asked: readonly ChangeRow[]): Promise<{ rows: ChangeRow[]; held: ChangeRow[]; gone: ChangeRow[]; expectOf: Map<ChangeRow, string> }> {
    let rows = await this.readUnits(asked);
    const checked = await mapLimit(
      rows.filter((row) => row.change.kind === "deleted" && !row.group),
      4,
      async (row) => ({ row, main: await this.deps.gitFile(row.doc) }),
    );
    const held = checked.filter(({ row, main }) => main.kind === "unreadable" || (main.kind === "file" && main.sha !== row.change.sha)).map(({ row }) => row);
    const gone = checked.filter(({ main }) => main.kind === "absent").map(({ row }) => row);
    if (gone.length) {
      for (const row of gone) this.deps.model.settledDelete(row.change.path);
      this.model.remember(gone);
      rows = rows.filter((row) => !gone.includes(row));
    }
    const expectOf = new Map(checked.flatMap(({ row, main }) => (main.kind === "file" ? [[row, main.sha] as const] : [])));
    return { rows, held, gone, expectOf };
  }

  async publish(asked: readonly ChangeRow[], options: { document?: boolean; asked?: true; knownPerFile?: true; countedRenames?: true } = {}): Promise<void> {
    const { rows: ready, held, expectOf } = await this.busy(() => this.readToPublish(asked), { words: CHECKING_WORDS, paths: asked.map((row) => row.change.path) });
    let rows = ready;
    if (rows.length === 0) return;
    if (held.length) {
      await this.alert({
        title: "Not deleted",
        description: `${names(held)} ${held.length === 1 ? "was" : "were"} changed on GitHub after you last had ${held.length === 1 ? "it" : "them"}, or couldn't be checked just now. Deleting could remove someone's newer work, so nothing was deleted. Restore ${held.length === 1 ? "it" : "them"} to see the change, or delete ${held.length === 1 ? "it" : "them"} in specgit.`,
      });
      rows = rows.filter((row) => !held.includes(row));
      if (rows.length === 0) return;
    }
    const toDelete = rows.filter((row) => row.change.kind === "deleted" && !row.group);
    const others = rows.filter((row) => !toDelete.includes(row));
    let knownPerFile = options.knownPerFile === true;
    let countedRenames = options.countedRenames === true;
    if (!options.asked) {
      let sets = this.moving.renamesFor(others, toDelete);
      let countRenames = false;
      if (sets.length > 0) {
        const known = await this.moving.knownNeedsReview(sets);
        if (known === "needs") {
          knownPerFile = true;
          sets = [];
        } else countRenames = known === "unknown";
      }
      countedRenames = countRenames;
      const fresh = this.freshOf(others.filter((row) => countRenames || !sets.includes(row)));
      const choice = await this.askSeparate(fresh, false, countRenames);
      if (choice === "cancel") return;
      if (choice === "group") {
        const grouped = await this.groupThem(fresh);
        if (!grouped) return;
        return this.publish([grouped, ...rows.filter((row) => !fresh.includes(row) || row.change.kind === "renamed")], { ...options, asked: true, ...(knownPerFile ? { knownPerFile: true as const } : {}), ...(countedRenames ? { countedRenames: true as const } : {}) });
      }
    }
    const group = rows.length === 1 ? rows[0]!.unit.group : undefined;
    const words = group
      ? { ...groupPublishWords(group), confirm: "Publish" }
      : options.document
        ? publishConfirm("note")
        : setPublishConfirm(
            others.map((row) => unitLabel(row.unit, () => noteName(row.change.path))),
            others.reduce((n, row) => n + documentsIn(row.unit), 0),
            false,
            this.model.publishQuota(),
            0,
            others.length,
          );
    if (others.length > 0 && !(await this.deps.dialogs.confirm({ title: words.title, description: words.description, confirmLabel: words.confirm }))) return;
    if (toDelete.length && !(await this.confirmDeletes(toDelete))) return;
    if (others.length === 1 && toDelete.length === 0) return this.publishSingle(others[0]!);
    const moves = knownPerFile ? [] : this.moving.renamesFor(others, toDelete);
    await this.publishSet(others.filter((row) => !moves.includes(row)), toDelete, expectOf, rows, moves, countedRenames);
  }

  private async publishSingle(row: ChangeRow): Promise<void> {
    await this.busy(async () => {
      const done: ChangeRow[] = [];
      const unchanged: string[] = [];
      try {
        const went = await this.publishing.single(row);
        if (went === "unchanged") unchanged.push(noteName(row.change.path));
        else if (!went) return;
        else {
          done.push(...this.filesOf(row));
          if (row.group) this.model.change({ kind: "gone", prNumbers: [row.group.overview.prNumber], paths: [] });
        }
      } finally {
        if (done.length) this.model.remember(done);
      }
      const unchangedWords = noChangeWords(unchanged, done.length === 0);
      if (unchangedWords) await this.alert({ title: NO_CHANGE_TITLE, description: unchangedWords });
    }, { words: BUSY_WORDS.publish, paths: [row.change.path], kind: "publish" });
  }

  private async publishSet(others: readonly ChangeRow[], toDelete: readonly ChangeRow[], expectOf: ReadonlyMap<ChangeRow, string>, rows: readonly ChangeRow[], moves: readonly ChangeRow[] = [], countedRenames = false): Promise<void> {
    await this.busy(async () => {
      const done: ChangeRow[] = [];
      const unchanged: string[] = [];
      const outcomes: Array<ItemOutcome> = [];
      const deleteToasts: Array<{ title: string; description: string }> = [];
      const linksKept: string[] = [];
      const nameOf = (path: string): string => {
        const row = rows.find((one) => one.change.path === path);
        return row ? unitLabel(row.unit, () => noteName(path)) : noteName(path);
      };
      try {
        let unsettled = false;
        const runOne = async (row: ChangeRow): Promise<void> => {
          const went = await this.publishing.forSet(row);
          if (went === "held") {
            unsettled = true;
            return;
          }
          if (went === "unchanged") {
            unchanged.push(noteName(row.change.path));
            return;
          }
          outcomes.push(went);
          if (went.status !== "done") return;
          done.push(...this.filesOf(row));
          if (row.group) this.model.change({ kind: "gone", prNumbers: [row.group.overview.prNumber], paths: [] });
        };
        for (const row of others) await runOne(row);
        let through = !unsettled && !outcomes.some((one) => one.status !== "done");
        let together = moves.length > 0 || toDelete.length >= 2;
        if (together && (moves.length > 0 || through)) {
          const sent = await this.moving.publish(moves, through ? toDelete : [], expectOf);
          outcomes.push(...sent.outcomes);
          done.push(...sent.done);
          deleteToasts.push(...sent.deleteToasts);
          linksKept.push(...sent.linksKept);
          if (sent.perFile) {
            together = false;
            const choice = countedRenames ? "separate" : await this.askSeparate(this.freshOf(moves), sent.learned);
            if (countedRenames && sent.learned) this.deps.dialogs.toast("Renaming one by one", SEPARATE_ASK.reason);
            if (choice === "cancel") unsettled = true;
            else for (const row of moves) await runOne(row);
            through = !unsettled && !outcomes.some((one) => one.status !== "done");
          }
        }
        for (const row of toDelete) {
          if (together && through) continue;
          if (!through) {
            outcomes.push({ path: row.change.path, status: "skipped", reason: DELETE_HELD_BACK });
            continue;
          }
          let removed = await this.deps.review.remove(row.doc, expectOf.get(row) ?? null);
          if (!removed.ok && removed.code === MAIN_MOVED && (await this.deps.gitFile(row.doc)).kind === "absent") removed = { ok: true, body: {} };
          if (!removed.ok) {
            const reason = removed.code === MAIN_MOVED ? `${noteName(row.change.path)} was changed on GitHub just now, so it was not deleted. Nothing was removed.` : failure(removed, COULD_NOT_PUBLISH);
            outcomes.push({ path: row.change.path, status: "failed", reason });
            continue;
          }
          this.deps.model.settledDelete(row.change.path);
          done.push(row);
          outcomes.push({ path: row.change.path, status: "done" });
          deleteToasts.push(deletedWords(/\.canvas$/i.test(row.change.path) ? "board" : "note", row.change.path, null, 0));
        }
      } finally {
        if (done.length) this.model.remember(done);
      }
      const complete = !outcomes.some((one) => one.status !== "done");
      if (!complete) {
        const lone = outcomes.length === 1 && outcomes[0]!.status === "failed" && toDelete.length === 1;
        if (lone) await this.alert({ title: couldntDeleteTitle(/\.canvas$/i.test(toDelete[0]!.change.path) ? "board" : "note"), description: (outcomes[0] as { reason: string }).reason });
        else await this.alert({ title: NOT_EVERYTHING_WENT_THROUGH, description: outcomes.map((one) => outcomeLine(one, nameOf)).join("\n") });
      } else {
        for (const deleted of deleteToasts) this.deps.dialogs.toast(deleted.title, deleted.description);
        if (linksKept.length > 0) {
          const kept = linksKeptWords(linksKept.map((path) => noteName(path)));
          this.deps.dialogs.toast(kept.title, kept.description);
        }
        const published = outcomes.filter((one) => !toDelete.some((row) => row.change.path === one.path));
        if (published.length) {
          const groups = published.filter((one) => rows.find((row) => row.change.path === one.path)?.group).length;
          this.deps.dialogs.toast(PUBLISHED_HERE.title, `${outcomesDescription(groups, published.length - groups)}.`);
        }
      }
      const unchangedWords = noChangeWords(unchanged, outcomes.length === 0);
      if (unchangedWords) {
        if (outcomes.length === 0) await this.alert({ title: NO_CHANGE_TITLE, description: unchangedWords });
        else this.deps.dialogs.toast(NO_CHANGE_TITLE, unchangedWords);
      }
    }, { words: others.length === 0 && moves.length === 0 ? "Deleting…" : moves.length > 0 && others.length === 0 && toDelete.length === 0 ? "Renaming…" : BUSY_WORDS.publish, paths: rows.map((row) => row.change.path), kind: "publish" });
  }

  private confirmDeletes(rows: readonly ChangeRow[]): Promise<boolean> {
    return this.deps.dialogs.confirm({
      title: rows.length === 1 ? DELETE_CONFIRM.title(noteName(rows[0]!.change.path), rows[0]!.doc.repo) : DELETE_CONFIRM.titleMany(rows.length, rows[0]!.doc.repo),
      points: rows.length === 1 ? DELETE_CONFIRM.points : DELETE_CONFIRM.pointsMany,
      confirmLabel: DELETE_CONFIRM.confirm,
      destructive: true,
    });
  }

  preview(doc: DocumentRef): Promise<CatchUpPreview | null> {
    return this.catchUps.preview(doc);
  }

  settleFromMain(row: ChangeRow, options: CatchUpAsked = {}): Promise<boolean> {
    return this.catchUps.settleFromMain(row, options);
  }

  catchUpWithMain(row: ChangeRow): Promise<boolean> {
    return this.catchUps.catchUpWithMain(row);
  }

  conflictPlaces(row: ChangeRow, preview: Extract<CatchUpPreview, { kind: "behind" }>): Promise<number | null> {
    return this.catchUps.conflictPlaces(row, preview);
  }

  catchUp(row: ChangeRow, preview: Extract<CatchUpPreview, { kind: "behind" }>, options: CatchUpAsked = {}): Promise<boolean> {
    return this.catchUps.catchUp(row, preview, options);
  }

  groupPlan(selected: readonly ChangeRow[]): GroupPlan {
    return this.groups.groupPlan(selected);
  }

  createGroup(asked: readonly ChangeRow[]): Promise<GroupChange> {
    return this.groups.createGroup(asked);
  }

  addToGroup(group: ChangeRow, asked: readonly ChangeRow[]): Promise<GroupChange> {
    return this.groups.addToGroup(group, asked);
  }

  takeOut(group: ChangeRow, path: string): Promise<GroupChange> {
    return this.groups.takeOut(group, path);
  }

  ungroup(group: ChangeRow): Promise<GroupChange> {
    return this.groups.ungroup(group);
  }

  stopEnding(group: ChangeRow): Promise<GroupChange> {
    return this.groups.stopEnding(group);
  }

  renameGroup(group: ChangeRow, name: string): Promise<GroupChange> {
    return this.groups.renameGroup(group, name);
  }

  resolveGroup(group: ChangeRow, pick: "mine" | "theirs"): Promise<GroupChange> {
    return this.groups.resolveGroup(group, pick);
  }

  discard(asked: readonly ChangeRow[]): Promise<void> {
    return this.discarding.run(asked);
  }

  async readReviews(files: readonly ChangeRow[]): Promise<ChangeRow[]> {
    const rows = await this.model.read(files);
    this.uploaded.clear();
    return rows;
  }

  async readReviewsFromMap(files: readonly ChangeRow[]): Promise<ChangeRow[]> {
    const rows = await this.model.readFromInFlight(files);
    this.uploaded.clear();
    return rows;
  }

  inReviewOfSomeoneElse(row: ChangeRow): boolean {
    return row.entry !== null && isAnotherAuthor(row.entry.authorLogin, this.deps.viewerLogin());
  }

  async closeReviews(rows: readonly ChangeRow[], step?: string, expectPr?: number | null): Promise<{ closed: ChangeRow[]; failed: { row: ChangeRow; result: Extract<StepResult, { ok: false }> } | null }> {
    const closed: ChangeRow[] = [];
    for (const row of rows) {
      const shown = row.entry?.prNumber;
      const expected = expectPr === null ? undefined : (expectPr ?? (row.review?.pr?.group === undefined && shown !== undefined && shown > 0 ? shown : undefined));
      const result = await this.deps.review.abandon(row.doc, step, expected);
      if (!result.ok) return { closed, failed: { row, result } };
      this.uploaded.clear();
      this.memory.forget(row.change.path);
      this.model.learnSent(row.change.path, null);
      this.model.learn(row.change.path, { reviewBranch: null, pr: null });
      closed.push(row);
    }
    return { closed, failed: null };
  }

  abandon(asked: readonly ChangeRow[]): Promise<void> {
    return this.stopping.run(asked);
  }

  approve(asked: readonly ChangeRow[]): Promise<ItemOutcome[]> {
    return this.approving.approve(asked);
  }

  askForChanges(asked: readonly ChangeRow[]): Promise<ItemOutcome[]> {
    return this.approving.askForChanges(asked);
  }

  abandonGroup(group: ChangeRow): Promise<void> {
    return this.stopping.runGroup(group);
  }
}

export type { GroupChange } from "./group-flows";
