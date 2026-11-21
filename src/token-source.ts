import type { DocumentRef } from "./mapping";

export interface RoomToken {
  url: string;
  room: string;
  token: string;
  readOnly?: boolean;
  steps?: RoomSteps;
}

export type StepSent = "out" | "ok" | "unsure";

export interface AskedStep {
  readonly id: string;
  readonly sent: StepSent;
}

export interface RoomSteps {
  readonly asked: readonly AskedStep[];
  readonly said: { readonly before: readonly string[]; readonly after: readonly string[] } | null;
  readonly failed?: true;
}

export interface TokenSource {
  roomToken(doc: DocumentRef, options?: { session?: string | null }): Promise<RoomToken>;
  askForBridge(doc: DocumentRef, options?: { session?: string | null }): Promise<{ steps?: RoomSteps; bridgeWaitSeconds?: number }>;
  leave(doc: DocumentRef): void;
}
