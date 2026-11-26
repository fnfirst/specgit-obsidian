import type { EditorView } from "@codemirror/view";
import { MarkdownView, type Plugin } from "obsidian";
import { bindLocalNewModel, coalesceDuringUntitled, isFreshUntitled, trackFreshLocalNotes } from "./local-new";
import type { ChangesModel } from "./model";
import { PANEL_TYPE } from "../panel/view";
import { barLines, noteBar, showBar } from "./note-bar";

export interface NoteBarSetup {
  model: ChangesModel;
  isLive: (path: string) => boolean;
  onStatus: (listener: () => void) => () => void;
  join: (path: string) => void;
  addToMyNote: (path: string) => void;
  stayOn?: () => boolean;
  settleFromMain?: (path: string) => void;
}

export function setUpNoteBar(plugin: Plugin, deps: NoteBarSetup): void {
  const { workspace } = plugin.app;
  trackFreshLocalNotes(plugin);
  bindLocalNewModel(plugin, deps.model);
  plugin.registerEditorExtension(noteBar);
  let hadAnyBar = false;
  const runRefresh = (): void => {
    const { aware, choices } = deps.model.state();
    if (aware === null && choices.size === 0 && !hadAnyBar) return;
    const panelShown = workspace.getLeavesOfType(PANEL_TYPE).some((leaf) => leaf.view.containerEl.isShown());
    let anyBar = false;
    workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) return;
      const path = view.file.path;
      const freshUntitled = isFreshUntitled(plugin, path);
      const row = freshUntitled ? undefined : (aware?.live.find((one) => one.path === path) ?? aware?.progress.find((one) => one.path === path));
      const rawChoice = freshUntitled ? undefined : choices.get(path);
      const choice =
        rawChoice === undefined
          ? undefined
          : {
              ...rawChoice,
              run: () => {
                const active = deps.stayOn?.() === false ? undefined : deps.model.state().choices.get(path);
                if (active) active.run();
                else deps.settleFromMain?.(path);
              },
            };
      const lines = barLines(row, deps.isLive(path), { join: () => deps.join(path), add: () => deps.addToMyNote(path) }, panelShown, choice);
      if (lines.length > 0) anyBar = true;
      if (lines.length === 0 && (cm.state.field(noteBar, false)?.length ?? 0) === 0) return;
      showBar(cm, lines);
    });
    hadAnyBar = anyBar;
  };
  const refresh = coalesceDuringUntitled(plugin, runRefresh, "microtask");
  plugin.register(deps.model.subscribe(refresh));
  plugin.register(deps.onStatus(refresh));
  plugin.registerEvent(workspace.on("active-leaf-change", refresh));
  plugin.registerEvent(workspace.on("layout-change", refresh));
  plugin.registerEvent(workspace.on("resize", refresh));
  plugin.registerEvent(workspace.on("file-open", refresh));
}
