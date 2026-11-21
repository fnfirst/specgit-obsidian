import { type Range, StateEffect, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { isAgentState } from "../presence";
import { CURSOR_FIELD } from "../protocol";
import { fillChip, forgetCaretName, pictureFailed, roomPerson, showCaretName, watchCaretChips } from "../shared/review-flow";
import { Alignment, type TreePoint } from "./alignment";
import type { TreeIndex } from "./tree-index";

export const redrawCarets = StateEffect.define<null>();

export interface CaretFields {
  color: string;
  label: string;
  initials: string;
  photo: string | null;
  placed: string;
}

export const BRIDGE_LAG_GRACE_MS = 500;

const sameVisual = (a: CaretFields, b: CaretFields): boolean => a.color === b.color && a.label === b.label && a.initials === b.initials && a.photo === b.photo;

export const sameFields = (a: CaretFields, b: CaretFields): boolean => sameVisual(a, b) && a.placed === b.placed;

export function drawCaret(fields: CaretFields, onPictureError?: () => void): HTMLElement {
  const { color, label, initials, photo } = fields;
  const caret = createSpan({ cls: "specgit-caret" });
  caret.setCssProps({ "--specgit-peer": color });
  const chip = caret.createSpan({ cls: "specgit-caret-chip" });
  fillChip(chip, initials, photo, () => {
    const img = createEl("img");
    if (onPictureError) img.addEventListener("error", onPictureError);
    return img;
  });
  caret.createSpan({ cls: "specgit-caret-flag", text: label });
  showCaretName(caret);
  return caret;
}

export interface PeerCaret extends CaretFields {
  id: number;
  anchor: number;
  head: number;
}

const drawnFields = new WeakMap<HTMLElement, { fields: CaretFields; drewFailed: boolean }>();

class Caret extends WidgetType {
  private readonly fields: CaretFields;

  constructor(fields: CaretFields) {
    super();
    this.fields = fields;
  }

  override eq(other: Caret): boolean {
    return sameFields(this.fields, other.fields);
  }

  toDOM(): HTMLElement {
    const record = { fields: this.fields, drewFailed: this.fields.photo !== null && pictureFailed(this.fields.photo) };
    const dom = drawCaret(this.fields, () => {
      record.drewFailed = true;
    });
    drawnFields.set(dom, record);
    return dom;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const prev = drawnFields.get(dom);
    if (!prev || !sameVisual(this.fields, prev.fields)) return false;
    if (prev.drewFailed && this.fields.photo !== null && !pictureFailed(this.fields.photo)) return false;
    showCaretName(dom);
    return true;
  }

  override destroy(dom: HTMLElement): void {
    drawnFields.delete(dom);
    forgetCaretName(dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

interface PeerState {
  [CURSOR_FIELD]?: { anchor?: unknown; head?: unknown } | null;
}

function treeText(doc: Y.Doc, json: unknown): TreePoint | null {
  if (typeof json !== "object" || json === null) return null;
  try {
    const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
    return at && (at.type instanceof Y.XmlText || at.type instanceof Y.XmlElement) ? { node: at.type, index: at.index, assoc: at.assoc } : null;
  } catch {
    return null;
  }
}

export const holdsFocus = (view: EditorView): boolean => view.root.activeElement === view.contentDOM;

export function personIsIn(view: EditorView): boolean {
  if (holdsFocus(view)) return true;
  const active = view.root.activeElement;
  return active !== null && view.contentDOM.contains(active) && active.closest("table") !== null && active.closest(".cm-editor") !== view.dom;
}

export class CaretLayer {
  decorations: DecorationSet = Decoration.none;
  peers: readonly PeerCaret[] = [];
  private published = "";
  private pending: number | null = null;
  private graceTimer: number | null = null;
  private readonly lastPlaced = new Map<number, { from: number; to: number; fields: CaretFields; heldSince: number | null }>();
  private cache: { text: Text; version: number; alignment: Alignment } | null = null;
  private readonly stops: Array<() => void> = [];
  private readonly listeners = new Set<(peers: readonly PeerCaret[]) => void>();
  private readonly names: ReturnType<typeof watchCaretChips>;

  constructor(
    private readonly view: EditorView,
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    private readonly tree: TreeIndex,
    private readonly redraw: () => void,
  ) {
    const onPresence = (change: { added: number[]; updated: number[]; removed: number[] }): void => {
      if ([...change.added, ...change.updated, ...change.removed].some((client) => client !== doc.clientID)) this.schedule();
    };
    awareness.on("change", onPresence);
    const onFocusIn = (): void => {
      this.published = "";
      this.publish();
    };
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget as Node | null;
      if (next?.instanceOf(Node) && view.contentDOM.contains(next)) return;
      this.publish();
    };
    view.contentDOM.addEventListener("focusin", onFocusIn);
    view.contentDOM.addEventListener("focusout", onFocusOut);
    this.names = watchCaretChips(view.dom, { chip: ".specgit-caret-chip", caret: ".specgit-caret" });
    this.stops.push(
      () => view.contentDOM.removeEventListener("focusin", onFocusIn),
      () => view.contentDOM.removeEventListener("focusout", onFocusOut),
      () => awareness.off("change", onPresence),
      tree.subscribe(() => this.schedule()),
      () => this.names.stop(),
    );
    this.decorations = this.draw();
  }

  listen(listener: (peers: readonly PeerCaret[]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      for (const held of this.lastPlaced.values()) {
        held.from = update.changes.mapPos(held.from);
        held.to = update.changes.mapPos(held.to);
      }
    }
    if (update.docChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(redrawCarets)))) {
      this.decorations = this.draw();
      this.listeners.forEach((listener) => listener(this.peers));
    }
    this.publish();
    this.names.redrawn();
  }

  destroy(): void {
    this.stops.forEach((stop) => stop());
    if (this.pending !== null) window.clearTimeout(this.pending);
    if (this.graceTimer !== null) window.clearTimeout(this.graceTimer);
    this.lastPlaced.clear();
    this.withdraw();
  }

  private schedule(): void {
    if (this.pending !== null) return;
    this.pending = window.setTimeout(() => {
      this.pending = null;
      this.redraw();
    }, 0);
  }

  private alignment(): Alignment {
    const text = this.view.state.doc;
    if (!this.cache || this.cache.text !== text || this.cache.version !== this.tree.version) {
      this.cache = { text, version: this.tree.version, alignment: new Alignment(this.tree.runs(), text.toString()) };
    }
    return this.cache.alignment;
  }

  private publish(): void {
    const { anchor, head } = this.view.state.selection.main;
    if (!personIsIn(this.view)) return this.withdraw();
    const alignment = this.alignment();
    const [from, to] = [alignment.toTree(anchor), alignment.toTree(head)];
    if (!from || !to) return this.withdraw();
    const position = ({ node, index, assoc }: TreePoint): unknown => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(node, index, assoc));
    const cursor = { anchor: position(from), head: position(to) };
    const said = JSON.stringify(cursor);
    if (said === this.published) return;
    this.published = said;
    this.awareness.setLocalStateField(CURSOR_FIELD, cursor);
  }

  private withdraw(): void {
    const current: unknown = (this.awareness.getLocalState() as PeerState | null)?.[CURSOR_FIELD] ?? null;
    if (this.published !== "" && JSON.stringify(current) === this.published) this.awareness.setLocalStateField(CURSOR_FIELD, null);
    this.published = "";
  }

  private draw(): DecorationSet {
    const length = this.view.state.doc.length;
    const marks: Array<Range<Decoration>> = [];
    const peers: PeerCaret[] = [];
    let alignment: Alignment | null = null;
    const now = Date.now();
    const active = new Set<number>();
    let nextExpiry: number | null = null;

    const emit = (client: number, from: number, to: number, fields: CaretFields): void => {
      peers.push({ ...fields, id: client, anchor: from, head: to });
      if (from !== to) {
        marks.push(Decoration.mark({ class: "specgit-selection", attributes: { style: `--specgit-peer: ${fields.color}` } }).range(Math.min(from, to), Math.max(from, to)));
      }
      marks.push(Decoration.widget({ widget: new Caret(fields), side: to > from ? -1 : 1 }).range(to));
    };

    this.awareness.getStates().forEach((state: PeerState | undefined, client) => {
      const cursor = state?.[CURSOR_FIELD];
      if (client === this.doc.clientID || !cursor) return;
      active.add(client);
      const [anchor, head] = [treeText(this.doc, cursor.anchor), treeText(this.doc, cursor.head)];
      const person = roomPerson(state);
      const color = person.color;
      const fields: CaretFields = { color, label: person.label, initials: person.initials, photo: isAgentState(state) ? null : person.picture, placed: JSON.stringify(cursor.head) };

      if (anchor && head) {
        alignment ??= this.alignment();
        const [anchorAt, headAt] = [alignment.toText(anchor.node, anchor.index, anchor.assoc), alignment.toText(head.node, head.index, head.assoc)];
        if (anchorAt !== null && headAt !== null) {
          const [from, to] = [Math.min(anchorAt, length), Math.min(headAt, length)];
          this.lastPlaced.set(client, { from, to, fields, heldSince: null });
          emit(client, from, to, fields);
          return;
        }
      }

      const prev = this.lastPlaced.get(client);
      if (!prev) return;
      const since = prev.heldSince ?? now;
      const remaining = BRIDGE_LAG_GRACE_MS - (now - since);
      if (remaining <= 0) {
        this.lastPlaced.delete(client);
        return;
      }
      prev.heldSince = since;
      const heldFields: CaretFields = { ...fields, placed: prev.fields.placed };
      prev.fields = heldFields;
      const [from, to] = [Math.min(prev.from, length), Math.min(prev.to, length)];
      emit(client, from, to, heldFields);
      nextExpiry = nextExpiry === null ? remaining : Math.min(nextExpiry, remaining);
    });

    for (const client of this.lastPlaced.keys()) {
      if (!active.has(client)) this.lastPlaced.delete(client);
    }

    if (this.graceTimer !== null) {
      window.clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (nextExpiry !== null) {
      this.graceTimer = window.setTimeout(() => {
        this.graceTimer = null;
        this.redraw();
      }, nextExpiry);
    }

    this.peers = peers.sort((a, b) => a.id - b.id);
    return Decoration.set(marks, true);
  }
}
