import { type ChangeDesc, type EditorState, type Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { MARK_TIP } from "./words";
import { type AnchorWords, isBlockAnchor, placeEdit, placeMark, type Span } from "./place";

export interface MarkThread {
  id: string;
  anchor: AnchorWords | null;
}

const setMarks = StateEffect.define<MarkThread[]>();

const setActive = StateEffect.define<string | null>();

const addMark = StateEffect.define<{ id: string; span: Span }>();

const track = StateEffect.define<{ key: string; span: Span }>();
const untrack = StateEffect.define<string>();

const OFFER = "menu-offer";

interface MarkState {
  ranges: ReadonlyMap<string, Span>;
  tracked: ReadonlyMap<string, Span>;
  active: string | null;
  decorations: DecorationSet;
}

function mapped(ranges: ReadonlyMap<string, Span>, changes: ChangeDesc): Map<string, Span> {
  const next = new Map<string, Span>();
  for (const [id, span] of ranges) {
    const from = changes.mapPos(span.from, 1);
    const to = changes.mapPos(span.to, -1);
    if (to > from) next.set(id, { from, to });
  }
  return next;
}

function decorate(ranges: ReadonlyMap<string, Span>, active: string | null): DecorationSet {
  return Decoration.set(
    [...ranges].map(([id, span]) =>
      Decoration.mark({
        class: `${isBlockAnchor(span) ? "specgit-comment-block" : "specgit-comment"}${id === active ? " is-active" : ""}`,
        attributes: { "data-comment-thread": id, title: MARK_TIP },
      }).range(span.from, span.to),
    ),
    true,
  );
}

const marks = StateField.define<MarkState>({
  create: () => ({ ranges: new Map(), tracked: new Map(), active: null, decorations: Decoration.none }),
  update(value, transaction) {
    let { ranges, tracked, active } = value;
    let changed = false;
    if (transaction.docChanged) {
      ranges = mapped(ranges, transaction.changes);
      tracked = mapped(tracked, transaction.changes);
      changed = true;
    }
    for (const effect of transaction.effects) {
      if (effect.is(setMarks)) {

        let text: string | null = null;
        const next = new Map<string, Span>();
        for (const thread of effect.value) {
          const existing = ranges.get(thread.id);
          if (existing) next.set(thread.id, existing);
          else if (thread.anchor) {
            text ??= transaction.state.doc.toString();
            const span = placeMark(text, thread.anchor);
            if (span) next.set(thread.id, span);
          }
        }
        ranges = next;
        changed = true;
      } else if (effect.is(setActive)) {
        active = effect.value;
        changed = true;
      } else if (effect.is(addMark)) {
        ranges = new Map(ranges).set(effect.value.id, effect.value.span);
        changed = true;
      } else if (effect.is(track)) {
        tracked = new Map(tracked).set(effect.value.key, effect.value.span);
      } else if (effect.is(untrack)) {
        const next = new Map(tracked);
        next.delete(effect.value);
        tracked = next;
      }
    }
    if (!changed && active === value.active && tracked === value.tracked) return value;
    return { ranges, tracked, active, decorations: changed ? decorate(ranges, active) : value.decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function markedRanges(state: EditorState): Array<{ from: number; to: number; active: boolean }> {
  const value = state.field(marks, false);
  return value ? [...value.ranges].map(([id, span]) => ({ ...span, active: id === value.active })) : [];
}

export function marksChanged(update: ViewUpdate): boolean {
  const [before, after] = [update.startState.field(marks, false), update.state.field(marks, false)];
  return before?.ranges !== after?.ranges || before?.active !== after?.active;
}

export interface MarkEvents {
  clicked(path: string, threadId: string | null): void;

  selected?(read: boolean): void;
}

export type ApplyStatus = "applied" | "not_found" | "failed";

const pathOf = (view: EditorView): string | null => view.state.field(editorInfoField, false)?.file?.path ?? null;

export class CommentMarks {
  private readonly views = new Set<EditorView>();
  private readonly lists = new Map<string, { threads: MarkThread[]; active: string | null }>();

  extension(events: MarkEvents): Extension {
    return [
      marks,
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) events.selected?.(update.transactions.every((tr) => !tr.selection || tr.annotation(Transaction.userEvent) === "select"));
      }),
      ViewPlugin.define(
        (view): PluginValue => {
          this.views.add(view);

          queueMicrotask(() => this.catchUp(view));
          return { destroy: () => void this.views.delete(view) };
        },
        {
          eventHandlers: {
            click: (event, view) => {
              const path = pathOf(view);
              if (path === null) return false;
              const marked = (event.target as HTMLElement | null)?.closest?.("[data-comment-thread]");
              events.clicked(path, marked?.getAttribute("data-comment-thread") ?? null);
              return false;
            },
          },
        },
      ),
    ];
  }

  private catchUp(view: EditorView): void {
    const path = pathOf(view);
    const list = path === null ? undefined : this.lists.get(path);
    if (!list || !this.views.has(view)) return;
    view.dispatch({ effects: [setMarks.of(list.threads), setActive.of(list.active)] });
  }

  private viewsOf(path: string): EditorView[] {
    return [...this.views].filter((view) => pathOf(view) === path);
  }

  editorOf(path: string): EditorView | null {
    const all = this.viewsOf(path);
    return all.find((view) => view.dom.isConnected && view.dom.offsetParent !== null) ?? all[0] ?? null;
  }

  editorFor(editor: unknown): EditorView | null {
    for (const view of this.views) if (view.state.field(editorInfoField, false)?.editor === editor) return view;
    return null;
  }

  show(path: string, threads: MarkThread[], active: string | null): void {
    this.lists.set(path, { threads, active });
    for (const view of this.viewsOf(path)) view.dispatch({ effects: [setMarks.of(threads), setActive.of(active)] });
  }

  forget(path: string): void {
    this.lists.delete(path);
    for (const view of this.viewsOf(path)) view.dispatch({ effects: setMarks.of([]) });
  }

  setActive(path: string, id: string | null): void {
    const list = this.lists.get(path);
    if (list) list.active = id;
    for (const view of this.viewsOf(path)) view.dispatch({ effects: setActive.of(id) });
  }

  has(path: string, id: string): boolean {
    const view = this.editorOf(path);
    return !!view && view.state.field(marks).ranges.has(id);
  }

  reveal(path: string, id: string): boolean {
    const view = this.editorOf(path);
    const span = view?.state.field(marks).ranges.get(id);
    if (!view || !span) return false;
    view.dispatch({ effects: EditorView.scrollIntoView(span.from, { y: "center" }) });
    return true;
  }

  follow(path: string, key: string, span: Span): void {
    const view = this.editorOf(path);
    if (view) view.dispatch({ effects: track.of({ key, span }) });
  }

  release(path: string, key: string): Span | null {
    const view = this.editorOf(path);
    if (!view) return null;
    const span = view.state.field(marks).tracked.get(key) ?? null;
    view.dispatch({ effects: untrack.of(key) });
    return span;
  }

  offer(view: EditorView, span: Span): void {
    view.dispatch({ effects: track.of({ key: OFFER, span }) });
  }

  offeredNow(view: EditorView): Span | null {
    return view.state.field(marks).tracked.get(OFFER) ?? null;
  }

  place(path: string, id: string, span: Span): void {
    for (const view of this.viewsOf(path)) view.dispatch({ effects: addMark.of({ id, span }) });
  }

  text(path: string): string | null {
    return this.editorOf(path)?.state.doc.toString() ?? null;
  }

  applyEdit(path: string, anchor: AnchorWords, replacement: string): ApplyStatus {
    const view = this.editorOf(path);
    if (!view || view.state.readOnly) return "failed";
    const span = placeEdit(view.state.doc.toString(), anchor);
    if (!span) return "not_found";
    view.dispatch({ changes: { from: span.from, to: span.to, insert: replacement } });
    return "applied";
  }
}
