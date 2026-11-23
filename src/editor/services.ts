import type { OwnLinks } from "../changes/own-links";
import type { PeerBoard } from "../cursors/reading";
import type { Connections } from "../connect/connections";
import type { BaseStore } from "../disk/bases";
import type { GitBases } from "../disk/git-bases";
import type { Region, Shown } from "../disk/regions";
import type { VaultPort } from "../disk/vault";
import type { DocumentRef } from "../mapping";
import type { OwnRestarts } from "../room/own-restarts";
import type { RoomPool } from "../room/pool";
import type { CanvasMergeResult } from "../shared/canvas/canvas-types";
import type { NoteStatus } from "../status";

export type ReviewFormat = "note" | "canvas" | "base";

export type Settle = null | { regions: Region[] } | { error: string };

export type ReviewSide = "live" | "github" | { teammate: string; submitted?: true };

export type ReviewPayload =
  | { kind: "text"; regions: Region[]; format: ReviewFormat; fromBase: boolean; merged?: Shown[] }
  | { kind: "canvas"; result: CanvasMergeResult; fromBase: boolean };

interface ReviewRequestBase {
  name: string;
  other?: ReviewSide;
  signal: AbortSignal;
}

export type TextReviewRequest = ReviewRequestBase & {
  kind: "text";
  regions: Region[];
  format?: ReviewFormat;
  fromBase: boolean;
  merged?: Shown[];
  settle?: () => Settle;
};

export type LiveReviewRequest = TextReviewRequest & { settle: () => Settle };

export type CanvasReviewRequest = ReviewRequestBase & {
  kind: "canvas";
  result: CanvasMergeResult;
  fromBase: boolean;
};

export type ReviewRequest = TextReviewRequest | CanvasReviewRequest;

export interface EditorServices {
  reading?: PeerBoard;
  documentFor(path: string): DocumentRef | null;
  onMapping(listener: () => void): () => void;
  rooms: RoomPool;
  connections: Connections;
  report(path: string, status: NoteStatus | null): void;
  notify(message: string, path?: string): void;
  notifyActions?(message: string, actions: ReadonlyArray<{ label: string; run: () => void }>, path?: string, lasting?: boolean): { shown(): boolean; hide(): void } | void;
  closeNote?(path: string): void;
  review(request: LiveReviewRequest): Promise<string | null>;
  cameIn(path: string, shown: Shown[] | null, words?: string): ((words: string) => void) | void;
  draftBy?(path: string): Promise<string | null>;
  vault: VaultPort;
  bases: BaseStore;
  gitBases: Pick<GitBases, "opened" | "underway">;
  isLocalOnlyNew?(path: string): boolean;
  onLayout?(listener: () => void): () => void;
  mainMoved?(path: string): boolean;
  ownRestarts: Pick<OwnRestarts, "pending" | "own" | "settle">;
  ownLinks?: Pick<OwnLinks, "added" | "moved" | "forget">;
  joined?(path: string): void;
  sentBase?(path: string, doc: DocumentRef, since?: number): Promise<string | null> | null;
  gitCopy(doc: DocumentRef): Promise<string | null>;
}
