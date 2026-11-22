import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";

interface FileBookkeeping {
  readonly saving?: boolean;
  lastSavedData?: string | null;
}

const REMEMBERED = 32;

export class OwnWrites {
  private readonly texts: Text[];

  constructor(private readonly view: EditorView) {
    this.texts = [view.state.doc];
  }

  remember(doc: Text): void {
    if (this.texts.at(-1) === doc) return;
    this.texts.push(doc);
    if (this.texts.length > REMEMBERED) this.texts.shift();
  }

  takeSave(panes: readonly OwnWrites[]): void {
    const mine = this.bookkeeping;
    if (!mine || mine.saving) return;
    const written = panes.find((pane) => pane !== this && pane.bookkeeping?.saving)?.bookkeeping?.lastSavedData;
    if (typeof written === "string" && this.holds(written)) mine.lastSavedData = written;
  }

  holds(text: string): boolean {
    return this.texts.some((held) => held.length === text.length && held.toString() === text);
  }

  private get bookkeeping(): FileBookkeeping | null {
    return (this.view.state.field(editorInfoField, false) as FileBookkeeping | undefined) ?? null;
  }
}
