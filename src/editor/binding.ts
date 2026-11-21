import { Annotation, type ChangeSpec, Transaction } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type * as Y from "yjs";
import { Budget, splices } from "../disk/diff";
import { type Eol, eolOf, LineEndingMap, toLf } from "../disk/line-endings";
import type { Splice } from "./splice";
import { cellFocus, restoreCellFocus } from "./table-focus";
import type { RoomUndo } from "./undo";

export const fromRoom = Annotation.define<true>();

const ROOM_CHANGE = [fromRoom.of(true), Transaction.addToHistory.of(false), Transaction.remote.of(true)];

const JOINING = {};

export interface BoundRoom {
  readonly text: Y.Text;
  readonly origin: object;
  readonly undo: RoomUndo;
  readonly readOnly: boolean;
}

const NARROW_MS = 30;

const JOIN_MS = 250;

function write(text: Y.Text, changes: readonly Splice[]): void {
  for (const { from, to, insert } of [...changes].reverse()) {
    if (to > from) text.delete(from, to - from);
    if (insert !== "") text.insert(from, insert);
  }
}

class Lens {
  private map = new LineEndingMap("");
  private eol: Eol = "lf";

  constructor(private readonly text: Y.Text) {
    this.read();
  }

  get projected(): string {
    return toLf(this.text.toJSON());
  }

  get length(): number {
    return this.text.length - this.map.pairs;
  }

  toEditor(offset: number): number {
    return this.map.toLf(offset);
  }

  toRoom(change: Splice): Splice {
    return this.map.toTextSplice(change, this.eol);
  }

  changed(inserted: string): void {
    if (this.map.crlf || inserted.includes("\r")) this.read();
  }

  private read(): void {
    const room = this.text.toJSON();
    this.map = new LineEndingMap(room);
    this.eol = eolOf(room);
  }
}

export class Binding {
  private bound = true;

  private constructor(
    private readonly view: EditorView,
    private readonly room: BoundRoom,
    private readonly lost: () => void,
    private readonly lens: Lens,
  ) {
    room.text.observe(this.onRoomChange);
  }

  static bind(view: EditorView, room: BoundRoom, lost: () => void, note: string): Binding {
    const { text } = room;
    const lens = new Lens(text);
    const [inRoom, editor] = [lens.projected, view.state.doc.toString()];
    const budget = new Budget(JOIN_MS);
    const target = room.readOnly ? inRoom : note;
    const toRoom = splices(inRoom, target, budget);
    if (toRoom.length > 0) {
      text.doc?.transact(() => write(text, toRoom.map((change) => lens.toRoom(change))), JOINING);
      lens.changed(toRoom.map((change) => change.insert).join(""));
    }
    const toEditor = splices(editor, target, budget);
    if (toEditor.length > 0) view.dispatch({ changes: toEditor.map(({ from, to, insert }): ChangeSpec => ({ from, to, insert })), annotations: ROOM_CHANGE });
    return new Binding(view, room, lost, lens);
  }

  static follow(view: EditorView, room: BoundRoom, lost: () => void): Binding {
    return Binding.bind(view, room, lost, toLf(room.text.toJSON()));
  }

  update(update: ViewUpdate): void {
    if (!this.bound || !update.docChanged) return;
    for (const transaction of update.transactions) {
      if (!transaction.docChanged || transaction.annotation(fromRoom) !== undefined) continue;
      if (this.room.readOnly) return this.fail();
      this.writeLocal(transaction);
    }
    this.checkLength();
  }

  stop(): void {
    if (!this.bound) return;
    this.bound = false;
    this.room.text.unobserve(this.onRoomChange);
  }

  private writeLocal(transaction: Transaction): void {
    const before = transaction.startState.doc;
    const edits: Splice[] = [];
    const budget = new Budget(NARROW_MS);
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      for (const change of splices(before.sliceString(fromA, toA), inserted.sliceString(0), budget)) {
        edits.push({ from: fromA + change.from, to: fromA + change.to, insert: change.insert });
      }
    });
    if (edits.length === 0) return;
    this.room.undo.remember(transaction.startState.selection);
    const changes = edits.map((edit) => this.lens.toRoom(edit));
    this.room.text.doc?.transact((written) => {
      written.meta.set(this, true);
      write(this.room.text, changes);
    }, this.room.origin);
    this.lens.changed(changes.map((change) => change.insert).join(""));
  }

  private readonly onRoomChange = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (transaction.meta.get(this)) return;
    const changes: ChangeSpec[] = [];
    let at = 0;
    let inserted = "";
    for (const op of event.delta) {
      if (typeof op.insert === "string") {
        changes.push({ from: this.lens.toEditor(at), insert: toLf(op.insert) });
        inserted += op.insert;
      } else if (op.insert !== undefined) {
        this.fail();
        return;
      } else if (op.delete !== undefined) {
        changes.push({ from: this.lens.toEditor(at), to: this.lens.toEditor(at + op.delete) });
        at += op.delete;
      } else if (op.retain !== undefined) {
        at += op.retain;
      }
    }
    if (changes.length === 0) return;
    this.lens.changed(inserted);
    const inCell = cellFocus(this.view);
    try {
      this.view.dispatch({ changes, annotations: ROOM_CHANGE });
      if (inCell) restoreCellFocus(this.view, inCell);
    } catch {
      this.fail();
      return;
    }
    this.checkLength();
  };

  private checkLength(): void {
    if (this.view.state.doc.length !== this.lens.length) this.fail();
  }

  private fail(): void {
    if (!this.bound) return;
    this.stop();
    this.lost();
  }
}
