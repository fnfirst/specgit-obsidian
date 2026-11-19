import type { PeerBoard } from "../cursors/reading";
import type { Connections } from "../connect/connections";
import type { BaseStore } from "../disk/bases";
import type { GitBases } from "../disk/git-bases";
import type { Region, Shown } from "../disk/regions";
import type { VaultPort } from "../disk/vault";
import type { DocumentRef } from "../mapping";
import type { OwnRestarts } from "../room/own-restarts";
import type { RoomPool } from "../room/pool";
import type { NoteStatus } from "../status";

export type Settle = null | { regions: Region[] } | { error: string };

export type ReviewSide = "live" | "github" | { teammate: string; submitted?: true };

export interface ReviewRequest {

  name: string;

  regions: Region[];

  fromBase: boolean;

  other?: ReviewSide;

  settle: () => Settle;

  merged?: Shown[];

  signal: AbortSignal;
}

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

  review(request: ReviewRequest): Promise<string | null>;

  cameIn(path: string, shown: Shown[] | null, words?: string): ((words: string) => void) | void;

  draftBy?(path: string): Promise<string | null>;

  vault: VaultPort;

  bases: BaseStore;

  gitBases: Pick<GitBases, "opened" | "underway">;

  mainMoved?(path: string): boolean;

  ownRestarts: Pick<OwnRestarts, "pending" | "own" | "settle">;

  joined?(path: string): void;

  gitCopy(doc: DocumentRef): Promise<string | null>;
}
