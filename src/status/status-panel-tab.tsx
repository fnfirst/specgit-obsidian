import { useEffect, useState } from "preact/hooks";
import { StatusPanel } from "../shared/status-panel";
import { type ChangesActions, NotInstalled } from "./not-installed";
import type { StatusController, StatusView } from "./controller";

export function StatusPanelTab({ controller, view, actions }: { controller: StatusController; view: StatusView | null; actions: ChangesActions }) {
  const [, tick] = useState(0);
  useEffect(() => controller.subscribe(() => tick((n) => n + 1)), [controller]);

  const watched = controller.unchangedPath(view);
  const phase = controller.phase();
  useEffect(() => controller.watchUnchanged(watched), [controller, watched, phase]);

  const unread = controller.unreadPath(view);
  useEffect(() => controller.readRow(unread), [controller, unread]);

  if (controller.phase() === "not-installed") return <NotInstalled actions={actions} />;
  const { model } = controller.build(view);
  return (
    <div class="sp-theme-obsidian specgit-status-panel" data-testid="status-panel">
      <StatusPanel model={model} host={controller.host} />
    </div>
  );
}
