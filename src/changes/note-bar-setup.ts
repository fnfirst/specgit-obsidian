import type { EditorView } from "@codemirror/view";
import { MarkdownView, type Plugin } from "obsidian";
import type { ChangesModel } from "./model";
import { PANEL_TYPE } from "../panel/view";
import { barLines, noteBar, showBar } from "./note-bar";

export interface NoteBarSetup {
  model: ChangesModel;
  isLive: (path: string) => boolean;
  onStatus: (listener: () => void) => () => void;
  join: (path: string) => void;
  addToMyNote: (path: string) => void;
}

export function setUpNoteBar(plugin: Plugin, deps: NoteBarSetup): void {
  const { workspace } = plugin.app;
  plugin.registerEditorExtension(noteBar);
  const refresh = (): void => {
    const { aware, choices } = deps.model.state();
    const panelShown = workspace.getLeavesOfType(PANEL_TYPE).some((leaf) => leaf.view.containerEl.isShown());
    workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) return;
      const path = view.file.path;
      const row = aware?.live.find((one) => one.path === path) ?? aware?.progress.find((one) => one.path === path);
      showBar(cm, barLines(row, deps.isLive(path), { join: () => deps.join(path), add: () => deps.addToMyNote(path) }, panelShown, choices.has(path) ? { ...choices.get(path)!, run: () => deps.model.state().choices.get(path)?.run() } : undefined));
    });
  };
  plugin.register(deps.model.subscribe(refresh));
  plugin.register(deps.onStatus(refresh));
  plugin.registerEvent(workspace.on("active-leaf-change", refresh));
  plugin.registerEvent(workspace.on("layout-change", refresh));
  plugin.registerEvent(workspace.on("resize", refresh));
  plugin.registerEvent(workspace.on("file-open", refresh));
}
