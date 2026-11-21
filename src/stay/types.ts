import type { NoticeHandle } from "../notices";
import type { Shown } from "../disk/regions";
import type { GuardedVault } from "../disk/guarded-vault";
import type { BranchFile, MainFile } from "../auth/git-copy";
import type { StayDrafts } from "./draft-state";
import type { End } from "./ends";
import type { ChangeRow } from "../changes/model";
import type { CopyInFile, CopyInResult } from "../changes/copy-in";
import type { ReviewRequest } from "../editor/services";
import type { DocumentRef } from "../mapping";
import type { NotePhase } from "../status";

export type StayVault = GuardedVault;

export type Committed =
  | "committed"
  | "held"
  | "limited"
  | "unsure"
  | "later"
  | "retry"
  | "deleted"
  | "conflict";

export interface SendHooks {
  memberBranch?: string;
  edit: true;
  ended?: true;
  notWritten(path: string): void;
  during<T>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null): Promise<T>;
}

export interface Agreement {
  sent: string;
  to: string | null;
  agreed?: string;
  commit?: string;
}

export interface StayPorts {
  copyIn(files: readonly CopyInFile[], isCurrent: () => boolean, skipped?: readonly string[]): Promise<CopyInResult>;
  now(): number;
  enabled(): boolean;
  signedIn(): boolean;
  documentFor(path: string): DocumentRef | null;
  phaseOf(path: string): NotePhase;
  disconnected(doc: DocumentRef): boolean;
  gitFile(doc: DocumentRef): Promise<MainFile>;
  blobTexts?(files: ReadonlyArray<{ doc: DocumentRef; sha: string }>): Promise<Map<string, string>>;
  reviewOf(doc: DocumentRef): Promise<"open" | "none" | "unknown">;
  vault: StayVault;
  baseText(path: string, sha: string | null): string | null;
  blobText(doc: DocumentRef, sha: string): Promise<string | null>;
  recordBase(path: string, doc: DocumentRef, text: string, raw: string): void;
  rebase(path: string, sha: string): void;
  chooseWhatToKeep(request: ReviewRequest): Promise<string | null>;
  commit(row: ChangeRow, isCurrent: () => boolean, hooks?: SendHooks): Promise<{ result: Committed; writes: number; deletedAt?: number }>;
  retryAttachments?(row: ChangeRow, isCurrent: () => boolean, hooks: SendHooks): Promise<{ result: "done" | "later" | "limited"; writes: number }>;
  hidden(): boolean;
  offline(): boolean;
  login(): string;
  policy(): StayDrafts;
  confirmGone?(docs: ReadonlyArray<DocumentRef>): Promise<Map<string, boolean> | null>;
  draftTexts?(files: ReadonlyArray<{ doc: DocumentRef; sha: string }>): Promise<Map<string, string>>;
  draftFile(doc: DocumentRef, branch: string): Promise<BranchFile>;
  wasDeleted(doc: DocumentRef): Promise<{ deletedAt: number } | null | "unknown">;
  reviewEnd(doc: DocumentRef, group?: boolean): Promise<End | "unknown">;
  reviewEnds?(files: ReadonlyArray<{ doc: DocumentRef; number: number; group?: boolean }>): Promise<Map<number, End | "unknown"> | null>;
  agreed(path: string, agreement: Agreement | null): void;
  agreedAs(path: string, agreed: string): void;
  forgetDelete(path: string): void;
  groupsOn(): boolean;
  groupsLocked(): boolean;
  inGroup(path: string): boolean;
  createGroup(rows: ChangeRow[]): Promise<{ outcome: "made" | "limited" | "failed"; writes: number }>;
  diagnose(what: string): void;
  aware(): boolean;
  notify(message: string, action?: { label: string; run: () => void; lasting?: boolean }): NoticeHandle | void;
  choice?(path: string, choice: { words: string; label: string; run: () => void } | null): void;
  heldDeletes?(offer: { count: number; move: () => void } | null): void;
  awareLine?(about: { added: number }): void;
  seeChanges?(shown: Shown[]): void;
  attachmentRow?(path: string, words: string | null): void;
  bringFor?(path: string, text: string): Promise<void>;
  bringAttachments?(doc: DocumentRef, branch: string, notePath: string, text: string, said: (words: string | null) => void, options?: { replace?: boolean }): Promise<void>;
  openStatus?(): void;
  settleReview(path: string): void;
  lookAgain(): void;
  personBusy(): boolean;
  later(fn: () => void, ms: number): () => void;
}
