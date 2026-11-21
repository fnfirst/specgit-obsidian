import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

const SYNC_MESSAGE = 0;
const SYNC_STEP_1 = 0;

const stateOf = (doc: Y.Doc): Map<number, number> => Y.decodeStateVector(Y.encodeStateVector(doc));

function holds(roomVector: Map<number, number>, clients: readonly number[]): boolean {
  return clients.length === 0 || roomVector.size === 0 || clients.some((client) => (roomVector.get(client) ?? 0) > 0);
}

export function sameLineage(doc: Y.Doc, roomVector: Map<number, number>): boolean {
  return holds(roomVector, [...stateOf(doc).keys()]);
}

export function lineageOf(doc: Y.Doc, most = 16): number[] {
  return [...stateOf(doc)]
    .sort(([, a], [, b]) => b - a)
    .slice(0, most)
    .map(([client]) => client);
}

export function holdsLineage(doc: Y.Doc, lineage: readonly number[]): boolean {
  return holds(stateOf(doc), lineage);
}

type SyncRead = { kind: "step1"; vector: Map<number, number> } | { kind: "sync" } | { kind: "other" };

class Reader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  number(): number {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.bytes[this.at++];
      if (byte === undefined) throw new Error("The message ended early.");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  }

  chunk(): Uint8Array {
    const length = this.number();
    const chunk = this.bytes.subarray(this.at, this.at + length);
    if (chunk.length !== length) throw new Error("The message ended early.");
    this.at += length;
    return chunk;
  }
}

export function readSync(data: unknown): SyncRead {
  if (Object.prototype.toString.call(data) !== "[object ArrayBuffer]") return { kind: "other" };
  try {
    const message = new Reader(new Uint8Array(data as ArrayBuffer));
    message.chunk();
    if (message.number() !== SYNC_MESSAGE) return { kind: "other" };
    if (message.number() !== SYNC_STEP_1) return { kind: "sync" };
    return { kind: "step1", vector: Y.decodeStateVector(message.chunk()) };
  } catch {
    return { kind: "other" };
  }
}

export class GuardedProvider extends HocuspocusProvider {
  private lineage: ((roomVector: Map<number, number>) => boolean) | null = null;
  private held: MessageEvent[] = [];
  private checked = false;

  guardReconnects(check: (roomVector: Map<number, number>) => boolean): void {
    if (this.lineage !== null) return;
    this.lineage = check;
    this.checked = true;
  }

  override onMessage(event: MessageEvent): void {
    if (this.lineage === null || this.checked) return super.onMessage(event);
    const message = readSync(event.data);
    if (message.kind === "other") return super.onMessage(event);
    if (message.kind === "sync") {
      this.held.push(event);
      return;
    }
    const held = this.held;
    this.held = [];
    if (!this.lineage(message.vector)) return;
    this.checked = true;
    for (const waiting of held) super.onMessage(waiting);
    super.onMessage(event);
  }

  override onClose(): void {
    this.held = [];
    this.checked = false;
    super.onClose();
  }
}
