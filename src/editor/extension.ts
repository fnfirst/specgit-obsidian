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
          if (event.inputType.startsWith("insert")) view.plugin(plugin)?.tryTyping();
          const undo = event.inputType === "historyUndo";
          if (!undo && event.inputType !== "historyRedo") return false;
          const handler = history(view);
          if (!handler) return false;
          event.preventDefault();
          return undo ? handler.undo(view) : handler.redo(view);
        },
      }),
    ]),
    plugin,
    renderedLayer({ peers: (view) => view.plugin(plugin)?.peers() ?? [], comments: markedRanges, commentsChanged: marksChanged }),
  ];
}
