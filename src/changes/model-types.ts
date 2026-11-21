import type { ChangeSet, ChangeSetEntry, GroupHeld, GroupOverview, PrInfo, ReviewSectionId, Selection, StatusUnits } from "../shared/review-flow";
import type { DocumentRef } from "../mapping";
import type { GroupsRead, PresenceRead, ReviewApi, ReviewStatus } from "../review/review-api";
import type { AwareState } from "./aware";
import type { AwareLine, HeldDeletes, NoteChoice } from "./awareness";
import type { Draft } from "../stay/draft-state";
import type { CacheEntry, FileCache, Gone, Listed } from "./cache";
import type { MirrorClient } from "./mirror";
import type { LocalChange } from "./plan";
import type { Sameness } from "./same-text";
import type { StatusRunning } from "../shared/status-panel";
import type { LeftOut } from "./left-out";
import type { TheirReview } from "./vault-state";

export interface ChangeRow {
  change: LocalChange;
  doc: DocumentRef;
  review: ReviewStatus | null;
  entry: ChangeSetEntry | null;
  unit: ChangeSetEntry;
  theirs?: TheirReview;
  unchecked?: boolean;
  unread?: boolean;
  light?: true;
  group?: GroupInfo;
  unchanged?: true;
}

export interface GroupInfo {
  id: string;
  overview: GroupOverview;
  held: GroupHeld | null;
  files: Array<{ path: string; row: ChangeRow | null }>;
  members: ChangeRow[];
}

export interface Looked {
  files: ReadonlyMap<string, CacheEntry>;
  repo: ReadonlyMap<string, string>;
  deleted: readonly Gone[];
  rows: readonly ChangeRow[];
  drafts?: { byPath: ReadonlyMap<string, Draft>; level: boolean; asOf?: number };
}

export type ChangesPhase = "signed-out" | "loading" | "ready" | "offline" | "not-installed" | "unmapped";

export type ChangesSectionId = "changed" | ReviewSectionId;

export interface Doing {
  words: string;
  paths: readonly string[];
  kind?: StatusRunning;
}

export interface ChangesState {
  phase: ChangesPhase;
  rows: ChangeRow[];
  set: ChangeSet;
  sections: Array<{ section: ChangesSectionId; rows: ChangeRow[] }>;
  groupsOn: boolean;
  groupsLocked: boolean;
  groups: ChangeRow[];
  loose: ChangeRow[];
  units: StatusUnits;
  selection: Selection;
  selected: ChangeRow[];
  published: ChangeRow[];
  busy: boolean;
  doing: Doing | null;
  missing: number;
  hidden: number;
  leftOut: LeftOut;
  copying: { done: number; total: number } | null;
  aware: AwareState | null;
  changedHere: ChangeRow[];
  progressRows: ReadonlyMap<string, ChangeRow>;
  line: AwareLine | null;
  choices: ReadonlyMap<string, NoteChoice>;
  heldDeletes: HeldDeletes | null;
}

export interface ChangesDeps {
  listFiles(): Listed[];
  readBytes(path: string): Promise<ArrayBuffer>;
  cache: FileCache;
  mirror: MirrorClient;
  review: Pick<ReviewApi, "status"> & {  details?: (repo: string, numbers: readonly number[]) => Promise<Map<number, PrInfo> | null | "failed"> };
  groups?(): Promise<GroupsRead>;
  presence?(): Promise<PresenceRead>;
  vaultPath?(path: string): string;
  documentFor(path: string): DocumentRef | null;
  signedIn(): boolean;
  viewerLogin?(): string;
  openComments?(path: string): number;
  deletedOnMain?(path: string): boolean;
  heldWhy?(path: string): string | null;
  isLive?(path: string): boolean;
  activePath?(): string | null;
  place?(): string;
  now?(): number;
  sameAsRepo?: (path: string, doc: DocumentRef, sha: string, repoSha: string, mayRead: boolean) => Promise<Sameness>;
  prefetchBlobs?: (reads: ReadonlyArray<{ doc: DocumentRef; sha: string }>) => Promise<void>;
}
