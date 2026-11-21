import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";

interface RelativeSelection {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

export class RoomUndo {
  private readonly manager: Y.UndoManager;
  private view: EditorView | null = null;
  private before: RelativeSelection | null = null;

  constructor(
    private readonly text: Y.Text,
    readonly origin: object,
    captureTimeout = 500,
  ) {
    this.manager = new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout });
    this.manager.on("stack-item-added", ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
      if (this.before && !stackItem.meta.has(this)) stackItem.meta.set(this, this.before);
    });
    this.manager.on("stack-item-popped", ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => this.restore(stackItem.meta.get(this) as RelativeSelection | undefined));
  }

  remember(selection: EditorSelection): void {
    const { anchor, head } = selection.main;
    this.before = { anchor: Y.createRelativePositionFromTypeIndex(this.text, anchor), head: Y.createRelativePositionFromTypeIndex(this.text, head) };
  }

  undo(view: EditorView): boolean {
    return this.run(view, () => this.manager.undo());
  }

  redo(view: EditorView): boolean {
    return this.run(view, () => this.manager.redo());
  }

  destroy(): void {
    this.manager.destroy();
    this.view = null;
  }

  private run(view: EditorView, step: () => unknown): true {
    this.view = view;
    try {
      step();
    } finally {
      this.view = null;
    }
    return true;
  }

  private restore(selection: RelativeSelection | undefined): void {
    const doc = this.text.doc;
    if (!selection || !this.view || !doc) return;
    const at = (position: Y.RelativePosition): number | null => Y.createAbsolutePositionFromRelativePosition(position, doc)?.index ?? null;
    const [anchor, head] = [at(selection.anchor), at(selection.head)];
    const length = this.view.state.doc.length;
    if (anchor === null || head === null || anchor > length || head > length) return;
    this.view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
  }
}
