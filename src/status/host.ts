import type { App } from "obsidian";
import { openMenu } from "../brand/menu";
import { askChoices } from "../changes/dialogs";
import type { PanelHost } from "../shared/status-panel";

export const nativeHost = (app: App): Required<Pick<PanelHost, "openMenu" | "confirm">> => ({
  openMenu: (items, anchor) =>
    void openMenu(
      anchor,
      items.map((item) => ({ label: item.label, run: item.run, ...(item.danger ? { danger: true } : {}) })),
      () => undefined,
    ),
  confirm: (question) => askChoices(app, question),
});
