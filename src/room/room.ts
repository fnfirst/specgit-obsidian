import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { retryAfterFromError } from "../api/retry-after";
import { TreeIndex } from "../cursors/tree-index";
import { RoomUndo } from "../editor/undo";
import type { DocumentRef } from "../mapping";
import { AuthError, type AuthErrorCode } from "../auth/errors";
import { type Here, type Identity, otherPeople, othersIn, ownPlacesIn, publishIdentity } from "../presence";
import { obsidianAlsoIn, personClientId } from "../shared/review-flow";
import { BRIDGE_FIELD, MARKDOWN_ROOT, sessionSeedClaim, TREE_ROOT } from "../protocol";
import type { RoomSteps } from "../token-source";
import { BridgeRequests } from "./bridge-requests";
import { isFresh, refusedBy, showsBridge, watchFreshness } from "./freshness";
import { outdatedRooms, PLUGIN_OUTDATED_BANNER } from "./outdated";
import { OwnChanges } from "./own-changes";
import type { OpenTransport, Stop, Transport } from "./transport";

export type RoomState = "connecting" | "joining" | "ready" | "failed";

export const RETRY_WAITS_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];

export const RECHECK_WAITS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

export const RECHECK_BEFORE_TRIES = 35;

const askAgain = (steps: RoomSteps | null | undefined): boolean => steps?.failed === true || (steps?.said?.before.length ?? 0) > 0;

const stepsIn = (answer: unknown): RoomSteps | null => (typeof answer === "object" && answer !== null && "steps" in answer ? ((answer as { steps?: RoomSteps }).steps ?? null) : null);

export const BRIDGE_GRACE_MS = 1_500;

export const OFFLINE_GRACE_MS = 10_000;

export class Room {
  readonly doc = Object.assign(new Y.Doc(), { clientID: personClientId() });
  readonly awareness = new Awareness(this.doc);
  readonly text = this.doc.getText(MARKDOWN_ROOT);
  readonly origin = {};
  readonly undo = new RoomUndo(this.text, this.origin);
  readonly tree = new TreeIndex(this.doc.getXmlFragment(TREE_ROOT));
  private transport: Transport | null = null;
  private stopWatchingTransport: (() => void) | null = null;
  private failure: string | null = null;
  private failedWith: AuthErrorCode | null = null;
  private ready = false;
  private destroyed = false;
  private lastSeen = "";
  private present = false;
  private replacement: Room | null = null;
  private vouchedText: string | null = null;
  private absence: number | null = null;
  private offlineTimer: number | null = null;
  private offlineExpired = false;
  private ended = false;
  private readonly bridgeRequests: BridgeRequests;
  private readonly ask: () => Promise<unknown>;
  private recheckTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryAtMs: number | null = null;
  private failedTries = 0;
  private readonly listeners = new Set<() => void>();
  private readonly stopWatchingFreshness: () => void;
  private readonly refusals = new Map<string, number>();
  private readonly own = new OwnChanges(this.text, { acknowledged: () => this.acknowledged });
  private readonly refusedListeners = new Set<(why: "riff" | "schema") => void>();
  private readonly leaving = new Map<number, boolean>();
  private wroteLocally = false;

  constructor(
    readonly ref: DocumentRef,
    private readonly open: OpenTransport,
    identity: Identity,
    askForBridge: (session: string | null) => Promise<unknown>,
  ) {
    this.ask = () =>
      askForBridge(sessionSeedClaim(this.doc)).then(
        (answer) => {
          const steps = stepsIn(answer);
          if (steps) this.transport?.setSteps(steps);
          return answer;
        },
        (error) => {
          if (this.destroyed) throw error;
          if (error instanceof AuthError && error.code === "room_ended") {
            this.ended = true;
            this.refresh();
          } else if (error instanceof AuthError && error.code === "document_deleted") {
            this.failedWith = "document_deleted";
            this.refresh();
          } else if (error instanceof AuthError && error.code === "plugin_outdated") {
            this.failOutdated(error.message);
          }
          throw error;
        },
      );
    this.bridgeRequests = new BridgeRequests(this.ask);
    publishIdentity(this.awareness, identity);
    this.stopWatchingFreshness = watchFreshness(this.doc, this.awareness, () => this.refresh());
    this.awareness.on("update", this.onAwareness);
    void this.connect();
  }

  onBridgeRefused(listener: (why: "riff" | "schema") => void): () => void {
    this.refusedListeners.add(listener);
    return () => void this.refusedListeners.delete(listener);
  }

  get state(): RoomState {
    if (this.failure !== null || this.offlineExpired) return "failed";
    if (this.ready) return "ready";
    if (this.transport?.refusal) return "failed";
    return this.transport?.synced ? "joining" : "connecting";
  }

  get problem(): string | null {
    return this.failure ?? this.transport?.refusal ?? null;
  }

  get name(): string | null {
    return this.transport?.name ?? null;
  }

  get steps(): RoomSteps | null {
    return this.transport?.steps ?? null;
  }

  get online(): boolean {
    return this.transport?.online ?? false;
  }

  get readOnly(): boolean {
    return this.transport?.readOnly ?? false;
  }

  get acknowledged(): boolean {
    return this.transport?.acknowledged ?? false;
  }

  get startOver(): boolean {
    return this.ended || (this.transport?.startOver ?? false);
  }

  get stopped(): Stop | null {
    return this.transport?.stopped ?? (this.failedWith === "document_deleted" ? "deleted" : null);
  }

  get bridgeHere(): boolean {
    return this.present;
  }

  get bindable(): boolean {
    return this.state === "ready" && this.present && !this.stopped;
  }

  get vouched(): string | null {
    return this.vouchedText;
  }

  get otherPeople(): Here[] {
    return otherPeople(this.awareness);
  }

  get failureCode(): AuthErrorCode | null {
    return this.failedWith;
  }

  get alsoIn(): string {
    return obsidianAlsoIn(ownPlacesIn(this.awareness));
  }

  get others(): number {
    return othersIn(this.awareness);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get retryAt(): number | null {
    return this.retryAtMs;
  }

  retry(): void {
    if (this.state !== "failed" || this.destroyed || this.ready || this.failedWith === "plugin_outdated" || this.failedWith === "document_deleted") return;
    this.stopWaitingToRetry();
    this.stopWaitingForBridge();
    this.stopWaitingOffline();
    this.failure = null;
    this.ready = false;
    this.present = false;
    this.offlineExpired = false;
    this.dropTransport();
    this.refresh();
    void this.connect();
  }

  get localEdited(): boolean {
    return this.wroteLocally;
  }

  markLocalEdit(): void {
    this.wroteLocally = true;
  }

  get successor(): Room | null {
    return this.replacement;
  }

  supersede(next: Room): void {
    if (this.wroteLocally) next.markLocalEdit();
    this.replacement = next;
    this.notify();
  }

  destroy(): void {
    this.destroyed = true;
    outdatedRooms.clear(this.ref, this);
    if (this.recheckTimer !== null) window.clearTimeout(this.recheckTimer);
    this.stopWaitingToRetry();
    this.listeners.clear();
    this.stopWatchingFreshness();
    this.awareness.off("update", this.onAwareness);
    this.stopWaitingForBridge();
    this.stopWaitingOffline();
    this.bridgeRequests.stop();
    this.dropTransport();
    this.own.stop();
    this.undo.destroy();
    this.tree.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private async connect(): Promise<void> {
    try {
      const transport = await this.open(this.ref, this.doc, this.awareness);
      if (this.destroyed) return transport.destroy();
      this.transport = transport;
      this.stopWatchingTransport = transport.subscribe(() => this.refresh());
      this.failedTries = 0;
      this.failedWith = null;
      outdatedRooms.clearRef(this.ref);
    } catch (error) {
      if (this.destroyed) return;
      if (error instanceof AuthError && error.code === "plugin_outdated") {
        this.failOutdated(error.message);
        return;
      }
      this.failure = error instanceof Error ? error.message : "Couldn't reach specgit.";
      this.failedWith = error instanceof AuthError ? error.code : null;
      if (this.failedWith !== "signed_out" && this.failedWith !== "document_deleted") {
        this.retryLater(retryAfterFromError(error));
      }
    }
    this.refresh();
  }

  private failOutdated(message: string): void {
    if (this.destroyed) return;
    this.failure = message;
    this.failedWith = "plugin_outdated";
    this.stopWaitingToRetry();
    this.stopWaitingForBridge();
    this.stopWaitingOffline();
    if (this.recheckTimer !== null) {
      window.clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
    this.bridgeRequests.stop();
    this.dropTransport();
    outdatedRooms.mark(this.ref, this, PLUGIN_OUTDATED_BANNER);
    this.refresh();
  }

  private retryLater(retryAfterMs?: number): void {
    const base = RETRY_WAITS_MS[Math.min(this.failedTries, RETRY_WAITS_MS.length - 1)] ?? 0;
    const wait = retryAfterMs === undefined ? base : Math.max(base, retryAfterMs);
    this.failedTries += 1;
    this.retryAtMs = Date.now() + wait;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.retry();
    }, wait);
  }

  private stopWaitingToRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAtMs = null;
  }

  private recheck(tries = 0): void {
    if (tries === 0 && !askAgain(this.transport?.steps)) return;
    const again = (retryAfterMs?: number): void => {
      if (this.destroyed) return;
      const base = RECHECK_WAITS_MS[Math.min(tries, RECHECK_WAITS_MS.length - 1)] ?? 0;
      const wait = retryAfterMs === undefined ? base : Math.max(base, retryAfterMs);
      this.recheckTimer = window.setTimeout(() => {
        this.recheckTimer = null;
        this.recheck(tries + 1);
      }, wait);
    };
    this.ask().then(
      (answer) => {
        const steps = stepsIn(answer);
        if (steps?.failed) again();
        else if (askAgain(steps) && tries + 1 < RECHECK_BEFORE_TRIES) again();
      },
      (error) => {
        if (this.failedWith === "plugin_outdated" || this.failedWith === "document_deleted") return;
        again(retryAfterFromError(error));
      },
    );
  }

  private dropTransport(): void {
    this.stopWatchingTransport?.();
    this.transport?.destroy();
    this.transport = null;
    this.stopWatchingTransport = null;
  }

  private readonly onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    for (const client of [...added, ...updated]) {
      const bridge: unknown = this.awareness.getStates().get(client)?.[BRIDGE_FIELD];
      if (typeof bridge === "object" && bridge !== null) this.leaving.set(client, (bridge as { leaving?: unknown }).leaving === true);
    }
    for (const client of removed) {
      if (this.leaving.get(client) === true) this.bridgeRequests.leftOnPurpose();
      this.leaving.delete(client);
    }
    for (const [session, refused] of refusedBy(this.awareness, [...added, ...updated])) {
      const before = this.refusals.get(session);
      this.refusals.set(session, refused.count);
      if (before === undefined) continue;
      for (const one of refused.recent.filter((recent) => recent.n > before)) {
        this.own.judge(one.range, one.landed, (told) => {
          if (told) [...this.refusedListeners].forEach((listener) => listener(one.why));
        });
      }
    }
    if (this.ready && showsBridge(this.doc, this.awareness, [...added, ...updated])) this.vouchedText = this.text.toJSON();
  };

  private refresh(): void {
    if (this.destroyed) return;
    if (this.transport?.outdated) {
      this.failOutdated(this.transport.outdated);
      return;
    }
    this.own.sweep();
    const synced = this.transport?.synced ?? false;
    const fresh = isFresh(this.doc, this.awareness);
    this.bridgeRequests.missing(synced && !fresh && this.stopped === null && !this.startOver && !this.readOnly);
    if (!this.ready && synced && fresh) {
      this.ready = true;
      this.present = true;
      this.vouchedText = this.text.toJSON();
      this.recheck();
    } else if (this.ready) this.followBridge(synced, fresh);
    const seen = `${this.state}/${this.online}/${this.readOnly}/${this.present}/${this.startOver}/${this.stopped}/${this.others}/${this.alsoIn}/${this.retryAtMs}/${this.failedWith ?? ""}`;
    if (seen === this.lastSeen) return;
    this.lastSeen = seen;
    this.notify();
  }

  private followBridge(synced: boolean, fresh: boolean): void {
    const connected = this.online && synced && !this.transport?.refusal;
    if (connected) {
      this.stopWaitingOffline();
      this.offlineExpired = false;
    } else {
      this.stopWaitingForBridge();
      if (!this.offlineExpired && this.offlineTimer === null && this.stopped === null && !this.startOver) {
        this.offlineTimer = window.setTimeout(() => {
          this.offlineTimer = null;
          if (!this.destroyed && (!this.online || !this.transport?.synced || Boolean(this.transport?.refusal)) && this.stopped === null && !this.startOver) {
            this.offlineExpired = true;
            this.present = false;
            this.refresh();
          }
        }, OFFLINE_GRACE_MS);
      }
    }
    if (fresh && connected) {
      this.stopWaitingForBridge();
      if (!this.present) {
        this.present = true;
        this.vouchedText = this.text.toJSON();
      }
    } else if (connected && this.present && this.absence === null) {
      this.absence = window.setTimeout(() => {
        this.absence = null;
        if (!this.destroyed && this.present && this.online && this.transport?.synced && !this.transport?.refusal && !isFresh(this.doc, this.awareness)) {
          this.present = false;
          this.refresh();
        }
      }, BRIDGE_GRACE_MS);
    }
  }

  private stopWaitingForBridge(): void {
    if (this.absence === null) return;
    window.clearTimeout(this.absence);
    this.absence = null;
  }

  private stopWaitingOffline(): void {
    if (this.offlineTimer === null) return;
    window.clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
  }

  private notify(): void {
    let failed: Error | null = null;
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        failed ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failed) throw failed;
  }
}
