import type { Plugin } from "obsidian";
import { MARK_ICON } from "../brand/mark";
import { coalesceDuringUntitled, isPluginLocalOnlyNew, onLocalNewUpdate, trackFreshLocalNotes } from "../changes/local-new";
import { PanelModel, type PanelDeps, type TabId } from "./model";
import type { PanelActions, PanelComments } from "./panel";
import { PANEL_TYPE, PanelView } from "./view";

export interface PanelHandle {
  model: PanelModel;
  reveal(tab?: TabId): Promise<void>;
}

const OPEN_PANEL = "Open specgit";

export function setUpPanel(plugin: Plugin, deps: PanelDeps, actions: PanelActions, comments: PanelComments): PanelHandle {
  const { workspace } = plugin.app;
  trackFreshLocalNotes(plugin);
  const model = new PanelModel({
    ...deps,
    isLocalOnlyNew: deps.isLocalOnlyNew ?? ((path) => isPluginLocalOnlyNew(plugin, path)),
  });
  plugin.registerView(PANEL_TYPE, (leaf) => new PanelView(leaf, model, actions, comments));

  const show = async (): Promise<void> => {
    const [first, ...extra] = workspace.getLeavesOfType(PANEL_TYPE);
    for (const one of extra) one.detach();
    let leaf = first;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? undefined;
      await leaf?.setViewState({ type: PANEL_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  };
  const reveal = async (tab?: TabId): Promise<void> => {
    if (tab) model.selectTab(tab);
    await show();
  };
  plugin.addRibbonIcon(MARK_ICON, OPEN_PANEL, () => void show());
  plugin.addCommand({ id: "show-panel", name: OPEN_PANEL, icon: MARK_ICON, callback: () => void show() });

  const scheduleUpdate = coalesceDuringUntitled(plugin, () => model.update());

  plugin.registerEvent(workspace.on("active-leaf-change", scheduleUpdate));
  plugin.registerEvent(workspace.on("file-open", scheduleUpdate));
  plugin.register(deps.status.subscribe(scheduleUpdate));
  plugin.register(deps.cameIn.subscribe(scheduleUpdate));
  plugin.register(onLocalNewUpdate(plugin, () => model.askPeople()));
  return { model, reveal };
}
