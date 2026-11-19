import * as Y from "yjs";

export interface RefusalRange {
  start: number[];
  end: number[];
}

export interface Landed {
  client: number;
  clock: number;

  since?: number;
}

const KEEP_MS = 2 * 60_000;

const KEEP_BYTES = 256 * 1024;
const ENTRY_BYTES = 24;

const CONTEXT = 3;

const WORDS_KEPT = 400;

const WAIT_MS = 30_000;

interface Written {

  clock: number;
  length: number;
  words: string;

  left: string;
  right: string;
  ackedAt: number | null;
}
interface Deleted {

  pos: Uint8Array;
  words: string;
  left: string;
  right: string;
  ackedAt: number | null;
}
interface Waiting {
  range: RefusalRange | null;
  landed: Landed | null;
  done: (told: boolean) => void;
  since: number;
  timer: number | null;
}

export interface OwnChangesOptions {
  now?: () => number;

  acknowledged?: () => boolean;
}

export class OwnChanges {
  private readonly written: Written[] = [];
  private readonly deleted: Deleted[] = [];

  private readonly selfDeleted: Array<[number, number]> = [];
  private readonly waiting: Waiting[] = [];
  private shadow: string;
  private readonly now: () => number;
  private readonly acknowledged: () => boolean;

  constructor(
    private readonly text: Y.Text,
    options: OwnChangesOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.acknowledged = options.acknowledged ?? (() => false);
    this.shadow = text.toJSON();
    text.observe(this.onChange);
    text.doc?.on("afterTransaction", this.onTransaction);
  }

  get size(): number {
    return this.written.length + this.deleted.length;
  }

  get bytes(): number {
    return this.written.reduce((sum, one) => sum + ENTRY_BYTES + one.words.length * 2, 0) + this.deleted.reduce((sum, one) => sum + one.pos.length + one.words.length * 2 + ENTRY_BYTES, 0) + this.selfDeleted.length * 16;
  }

  stop(): void {
    this.text.unobserve(this.onChange);
    this.text.doc?.off("afterTransaction", this.onTransaction);
    for (const one of this.waiting.splice(0)) if (one.timer) window.clearTimeout(one.timer);
  }

  private get doc(): Y.Doc | null {
    return this.text.doc;
  }

  private readonly onChange = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    const doc = this.doc;
    if (!doc) return;
    if (transaction.local) {
      this.noteOwn(event, transaction, doc);

      this.forget(false);
    }
    this.shadow = this.text.toJSON();
  };

  private noteOwn(event: Y.YTextEvent, transaction: Y.Transaction, doc: Y.Doc): void {
    for (const gone of transaction.deleteSet.clients.get(doc.clientID) ?? []) this.selfDeleted.push([gone.clock, gone.clock + gone.len]);
    let [oldIndex, newIndex] = [0, 0];
    for (const step of event.delta) {
      if (step.retain !== undefined) {
        oldIndex += step.retain;
        newIndex += step.retain;
      } else if (step.insert !== undefined) {
        const length = typeof step.insert === "string" ? step.insert.length : 1;

        const first = Y.createRelativePositionFromTypeIndex(this.text, newIndex, 0).item;
        if (first && first.client === doc.clientID) this.written.push({ clock: first.clock, length, words: typeof step.insert === "string" ? step.insert.slice(0, WORDS_KEPT) : "", left: this.shadow.slice(Math.max(0, oldIndex - CONTEXT), oldIndex), right: this.shadow.slice(oldIndex, oldIndex + CONTEXT), ackedAt: null });
        newIndex += length;
      } else if (step.delete !== undefined) {
        const words = this.shadow.slice(oldIndex, oldIndex + step.delete).slice(0, WORDS_KEPT);
        this.deleted.push({ pos: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, newIndex, 0)), words, left: this.shadow.slice(Math.max(0, oldIndex - CONTEXT), oldIndex), right: this.shadow.slice(oldIndex + step.delete, oldIndex + step.delete + CONTEXT), ackedAt: null });
        oldIndex += step.delete;
      }
    }
  }

  private readonly onTransaction = (): void => {
    this.settle();
  };

  sweep(): void {
    this.forget(true);
  }

  private forget(stamp: boolean): void {
    const now = this.now();
    if (stamp && this.acknowledged()) for (const one of [...this.written, ...this.deleted]) one.ackedAt ??= now;
    const old = (one: { ackedAt: number | null }): boolean => one.ackedAt !== null && now - one.ackedAt > KEEP_MS;
    for (const list of [this.written, this.deleted] as Array<Array<{ ackedAt: number | null }>>) {
      for (let i = list.length - 1; i >= 0; i -= 1) if (old(list[i]!)) list.splice(i, 1);
    }
    while (this.bytes > KEEP_BYTES && (this.written.length > 0 || this.deleted.length > 0)) {
      if (this.written.length >= this.deleted.length) this.written.shift();
      else this.deleted.shift();
    }
  }

  judge(range: RefusalRange | null | undefined, landed: Landed | null | undefined, done: (told: boolean) => void): void {
    const wait: Waiting = { range: range ?? null, landed: landed ?? null, done, since: this.now(), timer: null };
    this.waiting.push(wait);
    wait.timer = window.setTimeout(() => this.finish(wait), WAIT_MS);
    this.settle();
  }

  private settle(): void {
    const doc = this.doc;
    for (const wait of [...this.waiting]) {
      if (wait.landed === null || (doc !== null && Y.getState(doc.store, wait.landed.client) >= wait.landed.clock)) this.finish(wait);
    }
  }

  private finish(wait: Waiting): void {
    const at = this.waiting.indexOf(wait);
    if (at < 0) return;
    this.waiting.splice(at, 1);
    if (wait.timer) window.clearTimeout(wait.timer);
    wait.done(this.touches(wait.range, wait.landed));
  }

  touches(range: RefusalRange | null | undefined, landed?: Landed | null): boolean {
    if (!range) return false;
    this.sweep();
    const doc = this.doc;
    if (!doc) return false;
    const [from, to] = [absolute(doc, range.start), absolute(doc, range.end)];
    if (from === null || to === null) return false;
    const [low, high] = [Math.min(from, to), Math.max(from, to)];
    const inside = (place: number | undefined): boolean => place !== undefined && low <= place && place <= high;
    const bridged = this.bridgeText(doc, landed ?? null, low, high);
    return this.written.some((one) => this.insertionUndone(doc, one, inside, bridged)) || this.deleted.some((one) => this.deletionUndone(doc, one, inside, bridged));
  }

  private bridgeText(doc: Y.Doc, landed: Landed | null, low: number, high: number): string[] {
    if (landed === null || landed.since === undefined) return [this.text.toJSON().slice(low, high)];
    const pieces: Array<{ start: number; words: string }> = [];
    for (let clock = landed.since; clock < landed.clock; ) {
      const item = Y.getItem(doc.store, Y.createID(landed.client, clock));
      if (!(item instanceof Y.Item)) break;
      clock = item.id.clock + item.length;
      if (item.parent !== this.text || item.deleted || !(item.content instanceof Y.ContentString)) continue;
      const start = Y.createAbsolutePositionFromRelativePosition(new Y.RelativePosition(null, null, item.id, 0), doc)?.index;
      if (start !== undefined && start <= high && start + item.length >= low) pieces.push({ start, words: item.content.str });
    }
    pieces.sort((a, b) => a.start - b.start);

    const runs: string[] = [];
    let end = -1;
    for (const piece of pieces) {
      if (piece.start === end && runs.length > 0) runs[runs.length - 1] += piece.words;
      else runs.push(piece.words);
      end = piece.start + piece.words.length;
    }
    return runs;
  }

  private insertionUndone(doc: Y.Doc, one: Written, inside: (place: number | undefined) => boolean, bridged: string[]): boolean {
    const end = one.clock + one.length;
    for (let clock = one.clock; clock < end; ) {
      const item = Y.getItem(doc.store, Y.createID(doc.clientID, clock));
      if (!(item instanceof Y.Item)) return false;
      const upTo = Math.min(end, item.id.clock + item.length);
      if (item.deleted && !this.selfDeleted.some(([a, b]) => a <= clock && upTo <= b)) {
        const place = Y.createAbsolutePositionFromRelativePosition(new Y.RelativePosition(null, null, Y.createID(doc.clientID, clock), 0), doc)?.index;
        if (inside(place) && !standsIn(bridged, one.left, one.words, one.right)) return true;
      }
      clock = upTo;
    }
    return false;
  }

  private deletionUndone(doc: Y.Doc, one: Deleted, inside: (place: number | undefined) => boolean, bridged: string[]): boolean {
    if (one.words === "") return false;
    const place = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(one.pos), doc)?.index;
    return inside(place) && standsIn(bridged, one.left, one.words, one.right);
  }
}

function standsIn(runs: readonly string[], left: string, words: string, right: string): boolean {
  if (words === "") return false;
  const trimmed = words.trim();
  if (trimmed === "") {

    if (runs.includes(words)) return true;
    const forms = [left + words + right, left + words, words + right];
    return runs.some((text) => forms.some((form) => form.length > words.length && text.includes(form)));
  }
  const squash = (text: string): string => text.replace(/\s+/g, "");
  const [core, before, after] = [squash(trimmed), squash(left), squash(right)];
  const forms = [before + core + after, before + core, core + after].filter((form) => form.length > core.length);
  if (runs.some((run) => run.trim() === trimmed)) return true;
  return runs.some((run) => {
    const text = squash(run);
    return forms.some((form) => text.includes(form)) || (core.length >= 12 && text.includes(core));
  });
}

function absolute(doc: Y.Doc, encoded: unknown): number | null {
  try {
    if (!Array.isArray(encoded) || encoded.length > 64 || !encoded.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)) return null;
    return Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(encoded as number[])), doc)?.index ?? null;
  } catch {
    return null;
  }
}
