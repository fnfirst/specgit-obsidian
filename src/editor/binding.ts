import { Annotation, type ChangeSpec, type EditorState, Transaction } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type * as Y from "yjs";
import { fileAttachmentLinks } from "../changes/attachment-links";
import { Budget, splices } from "../disk/diff";
import { type Eol, eolOf, LineEndingMap, toLf } from "../disk/line-endings";
import type { Splice } from "./splice";
import { cellFocus, restoreCellFocus } from "./table-focus";
import type { RoomUndo } from "./undo";

export interface LocalLinkSink {
  readonly path: string;
  added(links: readonly string[]): void;
}

export function addedAttachmentLinks(path: string, transaction: Transaction): string[] {
  let check = false;
  const after = transaction.state.doc;
  transaction.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    if (check) return;
    if (inserted.length > 1) {
      check = true;
      return;
    }
    const text = inserted.sliceString(0);
    if (text.includes("]") || text.includes(")")) {
      check = true;
      return;
    }
    const startLine = after.lineAt(fromB).number;
    const endLine = after.lineAt(toB).number;
    for (let n = startLine; n <= endLine; n++) {
      const line = after.line(n).text;
      if (line.includes("[[") || line.includes("](")) {
        check = true;
        return;
      }
    }
  });
  if (!check) return [];
  const beforeLinks = new Set(fileAttachmentLinks(path, transaction.startState.doc.toString()));
  return fileAttachmentLinks(path, after.toString()).filter((link) => !beforeLinks.has(link));
}

export const fromRoom = Annotation.define<true>();

const ROOM_CHANGE = [fromRoom.of(true), Transaction.addToHistory.of(false), Transaction.remote.of(true)];

const JOINING = {};

export interface BoundRoom {
  readonly text: Y.Text;
  readonly origin: object;
  readonly undo: RoomUndo;
  readonly readOnly: boolean;
  markLocalEdit?(): void;
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
  private eol: Eol;

  constructor(
    private readonly text: Y.Text,
    preferredEol: Eol = "lf",
  ) {
    this.eol = preferredEol;
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
    if (room !== "" && room.includes("\n")) this.eol = eolOf(room);
  }
}

export class Binding {
  private bound = true;

  private constructor(
    private readonly view: EditorView,
    private readonly room: BoundRoom,
    private readonly lost: () => void,
    private readonly lens: Lens,
    private boundFile: object | null,
    private boundPath: string | null,
    private readonly links?: LocalLinkSink,
  ) {
    room.text.observe(this.onRoomChange);
  }

  static bind(view: EditorView, room: BoundRoom, lost: () => void, note: string, links?: LocalLinkSink, expectedPath?: string, preferredEol?: Eol): Binding {
    const { text } = room;
    const active = view.state.field(editorInfoField, false)?.file ?? null;
    const boundPath = expectedPath ?? active?.path ?? null;
    const eol: Eol = preferredEol ?? (note.includes("\r\n") ? "crlf" : "lf");
    const lens = new Lens(text, eol);
    const [inRoom, editor] = [lens.projected, view.state.doc.toString()];
    const budget = new Budget(JOIN_MS);
    const target = room.readOnly ? inRoom : note;
    const toRoom = splices(inRoom, target, budget);
    if (toRoom.length > 0) {
      room.markLocalEdit?.();
      const changes = toRoom.map((change) => lens.toRoom(change));
      text.doc?.transact(() => write(text, changes), JOINING);
      lens.changed(changes.map((change) => change.insert).join(""));
    }
    const toEditor = splices(editor, target, budget);
    if (toEditor.length > 0) view.dispatch({ changes: toEditor.map(({ from, to, insert }): ChangeSpec => ({ from, to, insert })), annotations: ROOM_CHANGE });
    return new Binding(view, room, lost, lens, active, boundPath, links);
  }

  static follow(view: EditorView, room: BoundRoom, lost: () => void, links?: LocalLinkSink, expectedPath?: string, preferredEol?: Eol): Binding {
    return Binding.bind(view, room, lost, toLf(room.text.toJSON()), links, expectedPath, preferredEol);
  }

  retarget(file: object | null, path: string | null): void {
    this.boundFile = file;
    this.boundPath = path;
  }

  update(update: ViewUpdate): void {
    if (!this.bound || !update.docChanged) return;
    if (!this.matchesView(update.state)) {
      this.stop();
      return;
    }
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

  private matchesView(state: EditorState = this.view.state): boolean {
    const info = state.field(editorInfoField, false);
    if (info === undefined) return true;
    const active = info.file ?? null;
    if (this.boundPath !== null && active?.path !== this.boundPath) return false;
    if (this.boundFile !== null && active !== this.boundFile) return false;
    return true;
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
    this.room.markLocalEdit?.();
    this.room.undo.remember(transaction.startState.selection);
    const changes = edits.map((edit) => this.lens.toRoom(edit));
    this.room.text.doc?.transact((written) => {
      written.meta.set(this, true);
      write(this.room.text, changes);
    }, this.room.origin);
    this.lens.changed(changes.map((change) => change.insert).join(""));
    if (this.links) {
      const added = addedAttachmentLinks(this.links.path, transaction);
      if (added.length > 0) this.links.added(added);
    }
  }

  private readonly onRoomChange = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (transaction.meta.get(this)) return;
    if (!this.matchesView()) {
      this.stop();
      return;
    }
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
