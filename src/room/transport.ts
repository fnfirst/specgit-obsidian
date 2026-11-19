import { WebSocketStatus } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { AuthError } from "../auth/errors";
import type { DocumentRef } from "../mapping";
import { type Lease, rejoinDelay, type SocketPool } from "../network/sockets";
import { ROOM_DIVERGED_MESSAGE, ROOM_ENDED_REASON, ROOM_TOO_LARGE, sessionSeedClaim } from "../protocol";
import type { RoomSteps, RoomToken, TokenSource } from "../token-source";
import { sameAccount, tokenSub } from "./account";
import { GuardedProvider, sameLineage } from "./lineage";

export type Stop = "diverged" | "too_large" | "deleted";

export interface Transport {

  readonly name: string;

  readonly steps: RoomSteps | null;

  setSteps(steps: RoomSteps | null): void;

  readonly synced: boolean;

  readonly acknowledged: boolean;

  readonly startOver: boolean;

  readonly stopped: Stop | null;

  readonly online: boolean;

  readonly refusal: string | null;

  readonly readOnly: boolean;

  subscribe(listener: () => void): () => void;
  destroy(): void;
}

export type OpenTransport = (ref: DocumentRef, doc: Y.Doc, awareness: Awareness) => Promise<Transport>;

const FIRST_TOKEN_MAX_AGE_MS = 60_000;

interface TokenEvents {

  readOnly(readOnly: boolean): void;

  startOver(): void;

  deleted(): void;

  steps(steps: RoomSteps | null): void;
}

function tokensFor(ref: DocumentRef, source: TokenSource, first: RoomToken, now: () => number, on: TokenEvents, session: () => string | null): () => Promise<string> {
  const issued = now();
  const account = tokenSub(first.token);
  let unused: string | null = first.token;
  return async () => {
    const given = unused;
    unused = null;
    if (given !== null && now() - issued < FIRST_TOKEN_MAX_AGE_MS) return given;
    let fresh: RoomToken;
    try {
      fresh = await source.roomToken(ref, { session: session() });
    } catch (error) {
      if (error instanceof AuthError && error.code === "room_ended") on.startOver();
      if (error instanceof AuthError && error.code === "document_deleted") on.deleted();
      throw error;
    }
    const sub = tokenSub(fresh.token);
    if (account !== null && sub !== null && !sameAccount(sub, account)) {
      on.startOver();
      throw new Error("This note was connected under a different account.");
    }
    on.readOnly(fresh.readOnly === true);

    on.steps(fresh.steps ?? null);
    return fresh.token;
  };
}

class HocuspocusTransport implements Transport {
  refusal: string | null = null;
  startOver = false;
  stopped: Stop | null = null;
  private readonly listeners = new Set<() => void>();

  private rejoins = 0;
  private rejoining: number | null = null;

  constructor(
    private readonly provider: GuardedProvider,
    private readonly lease: Lease,
    readonly name: string,
    doc: Y.Doc,
    private isReadOnly: boolean,
    private latestSteps: RoomSteps | null,
  ) {
    provider.on("synced", () => {
      this.rejoins = 0;

      provider.guardReconnects((roomVector) => {
        if (sameLineage(doc, roomVector)) return true;
        this.restart();
        return false;
      });
      this.changed();
    });
    provider.on("status", () => this.changed());
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => this.refused(reason));
    provider.on("authenticated", () => {
      this.refusal = null;
      this.changed();
    });

    provider.on("stateless", ({ payload }: { payload: string }) => {
      if (payload === ROOM_DIVERGED_MESSAGE) this.stop("diverged");
      else if (payload === ROOM_TOO_LARGE) this.stop("too_large");
    });

    provider.on("close", () => {
      this.changed();
      if (this.lease.socket.status === WebSocketStatus.Connected) this.rejoin();
    });
    provider.attach();
  }

  get synced(): boolean {
    return this.provider.isSynced;
  }

  get online(): boolean {
    return this.live && this.lease.socket.status === WebSocketStatus.Connected && this.provider.isAuthenticated;
  }

  get acknowledged(): boolean {
    return this.synced && this.online && !this.provider.hasUnsyncedChanges;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get readOnly(): boolean {
    return this.isReadOnly;
  }

  get steps(): RoomSteps | null {
    return this.latestSteps;
  }

  setSteps(steps: RoomSteps | null): void {
    if (steps !== null && steps.said !== null) this.latestSteps = steps;
  }

  setReadOnly(readOnly: boolean): void {
    if (readOnly === this.isReadOnly) return;
    this.isReadOnly = readOnly;
    this.changed();
  }

  restart(): void {
    if (!this.live) return;
    this.startOver = true;
    this.end();
    this.changed();
  }

  stopForDeleted(): void {
    this.stop("deleted");
  }

  destroy(): void {
    this.listeners.clear();
    this.stopRejoining();

    this.provider.destroy();
    this.lease.release();
  }

  private get live(): boolean {
    return this.stopped === null && !this.startOver;
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener());
  }

  private refused(reason: string): void {
    if (!this.live) return;

    if (reason === ROOM_ENDED_REASON) return this.restart();
    if (reason === ROOM_TOO_LARGE) return this.stop("too_large");
    this.refusal = reason;
    this.changed();
    this.rejoin();
  }

  private stop(why: Stop): void {
    if (!this.live) return;
    this.stopped = why;
    this.end();
    this.changed();
  }

  private end(): void {
    this.stopRejoining();
    this.provider.detach();
  }

  private rejoin(): void {
    if (!this.live || this.rejoining !== null) return;
    const { socket } = this.lease;
    socket.disconnect();
    this.rejoining = window.setTimeout(() => {
      this.rejoining = null;
      void socket.connect();
    }, rejoinDelay(this.rejoins++));
  }

  private stopRejoining(): void {
    if (this.rejoining !== null) window.clearTimeout(this.rejoining);
    this.rejoining = null;
  }
}

export function hocuspocusTransport(sockets: SocketPool, tokens: TokenSource, now: () => number = Date.now): OpenTransport {
  return async (ref, doc, awareness) => {

    const first = await tokens.roomToken(ref, { session: sessionSeedClaim(doc) });
    const lease = sockets.lease(first.url);
    let transport: HocuspocusTransport | null = null;
    const token = tokensFor(ref, tokens, first, now, { readOnly: (readOnly) => transport?.setReadOnly(readOnly), startOver: () => transport?.restart(), deleted: () => transport?.stopForDeleted(), steps: (steps) => transport?.setSteps(steps) }, () => sessionSeedClaim(doc));
    const provider = new GuardedProvider({ websocketProvider: lease.socket, name: first.room, document: doc, awareness, token });
    transport = new HocuspocusTransport(provider, lease, first.room, doc, first.readOnly === true, first.steps ?? null);
    return transport;
  };
}
