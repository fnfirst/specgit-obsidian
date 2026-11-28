import type { Attachment } from "./attachment-memory";
import type { BlobsAnswer } from "../auth/git-copy";
import type { GuardedVault } from "../disk/guarded-vault";
import type { NotePhase } from "../status";
import type { Budget } from "../disk/diff";
import type { Shown } from "../disk/regions";
import type { ReviewRequest } from "../editor/services";
import type { DocumentRef } from "../mapping";
import type { NoticeHandle } from "../notices";
import type { BranchFile, MainFile } from "../auth/git-copy";
import type { Reviewer, ReviewApi } from "../review/review-api";
import type { ChangesContext } from "../review/words";
import type { OwnRestarts } from "../room/own-restarts";
import type { ChangesModel } from "./model";
import type { SentRecord } from "./sent-memory";

export interface Point {
  icon: string;
  text: string;
}

export interface DialogWords {
  description?: string;
  points?: readonly Point[];
  note?: string;
}

export function dialogText({ description, points, note }: DialogWords): string {
  return [description, ...(points ?? []).map(({ text }) => (/[.?!…]$/.test(text) ? text : `${text}.`)), note].filter(Boolean).join(" ");
}

export interface Dialogs {
  confirm(options: { title: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean } & DialogWords): Promise<boolean>;
  choose(options: { title: string; confirmLabel: string; cancelLabel: string } & DialogWords): Promise<boolean | null>;
  alert(options: { title: string; href?: string | null; hrefLabel?: string } & DialogWords): Promise<void>;
  toast(title: string, description?: string): void;
  askNote(options: { title: string; description: string; label: string; placeholder: string; confirmLabel: string; required: string }): Promise<string | null>;
  pickReviewer(candidates: readonly Reviewer[], description: string): Promise<Reviewer | null>;
}

export interface AttachmentQuery {
  onlyMine?: boolean;
  baselines?: readonly string[];
  branch?: string | null;
}

export interface FlowDeps {
  review: ReviewApi;
  model: ChangesModel;
  dialogs: Dialogs;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string, expected: string): Promise<boolean | string>;
  vault: GuardedVault;
  phaseOf(path: string): NotePhase;
  hasRoomBase(path: string): boolean;
  othersHere(path: string): number;
  ownRestarts: Pick<OwnRestarts, "expect" | "sent" | "done">;
  keepBase(path: string, doc: DocumentRef, raw: string): () => void;
  deletesForGood(): boolean;
  gitCopy(doc: DocumentRef): Promise<string | null>;
  gitFile(doc: DocumentRef): Promise<MainFile>;
  gitBlobs?(repo: string, commit: string | null, files: ReadonlyArray<{ sha: string; path: string }>, byBlob?: boolean): Promise<BlobsAnswer>;
  branchFile(doc: DocumentRef, branch: string): Promise<BranchFile>;
  baseText(path: string): string | null;
  sentCommit?(path: string): string | undefined;
  sentText?: Map<string, SentRecord>;
  now?: () => number;
  pause?(ms: number): Promise<void>;
  gitBlob(doc: DocumentRef, sha: string): Promise<string | null>;
  chooseWhatToKeep(request: ReviewRequest): Promise<string | null>;
  attachments(path: string, query?: AttachmentQuery): Promise<Attachment[]>;
  attachmentAgreed?(repoPath: string, sha: string): void;
  bringFor?(path: string, text: string): Promise<void>;
  attachmentHeld?(repoPath: string, sha: string): boolean;
  attachmentTold?(path: string, words: readonly string[]): void;
  attachmentProblems?(path: string, problems: ReadonlyArray<{ name: string; why: string }>): void;
  documentFor(path: string): DocumentRef | null;
  viewerLogin(): string;
  candidates(doc: DocumentRef): Promise<Reviewer[]>;
  openComments?(path: string): number;
  showChanges(shown: Shown[], context: ChangesContext): void;
  stopped?(path: string): void;
  deleted?(path: string, at: number): void;
  deletedAt?(path: string): number | null;
  restored?(path: string): void;
  conflictResolved?(path: string): void;
  publishedBranch: string;
  budget?: () => Budget;
  deleteCloseDelayMs?: number;
  scheduleTimer?: (fn: () => void, ms: number) => () => void;
  notifyDeleteWithUndo?: (message: string, label: string, run: () => void) => NoticeHandle;
}
