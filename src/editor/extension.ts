import { type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { Platform } from "obsidian";
import { markedRanges, marksChanged } from "../comments/marks";
import { renderedLayer } from "../cursors/rendered";
import { NoteEditor } from "./note-editor";
import { NoteNotices } from "./note-notices";
import { deletedField, phaseBadge, phaseField, readerField } from "./phase";
import { NoteRegistry } from "./registry";
import type { EditorServices } from "./services";
import type { RoomUndo } from "./undo";

function isEditKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1 || event.key === "Backspace" || event.key === "Delete" || event.key === "Enter" || event.key === "Tab";
}

export function liveEditor(services: EditorServices): Extension {
  const registry = new NoteRegistry<NoteEditor>();
  const told = new NoteNotices();
  const plugin = ViewPlugin.define((view) => new NoteEditor(view, services, registry, told), { decorations: (editor) => editor.decorations });
  const history = (view: EditorView): RoomUndo | null => view.plugin(plugin)?.history() ?? null;
  return [
    readerField,
    deletedField,
    phaseField,
    Platform.isMobile ? phaseBadge : [],
    Prec.highest([
      keymap.of([
        { key: "Mod-z", run: (view) => history(view)?.undo(view) ?? false },
        { key: "Mod-Shift-z", run: (view) => history(view)?.redo(view) ?? false },
        { key: "Mod-y", run: (view) => history(view)?.redo(view) ?? false },
      ]),
      EditorView.domEventHandlers({
        beforeinput: (event, view) => {
          if (event.inputType.startsWith("insert") || event.inputType.startsWith("delete")) view.plugin(plugin)?.tryTyping();
          const undo = event.inputType === "historyUndo";
          if (!undo && event.inputType !== "historyRedo") return false;
          const handler = history(view);
          if (!handler) return false;
          event.preventDefault();
          return undo ? handler.undo(view) : handler.redo(view);
        },
        keydown: (event, view) => {
          if (isEditKey(event)) view.plugin(plugin)?.tryTyping();
          return false;
        },
        paste: (_event, view) => {
          view.plugin(plugin)?.tryTyping();
          return false;
        },
      }),
    ]),
    plugin,
    renderedLayer({ peers: (view) => view.plugin(plugin)?.peers() ?? [], comments: markedRanges, commentsChanged: marksChanged }),
  ];
}
