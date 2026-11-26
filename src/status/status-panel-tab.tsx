import { useEffect, useState } from "preact/hooks";
import { untitledCreateRemainingMs } from "../changes/local-new";
import { StatusPanel } from "../shared/status-panel";
import { type ChangesActions, NotInstalled } from "./not-installed";
import type { StatusController, StatusView } from "./controller";

export function StatusPanelTab({ controller, view, actions }: { controller: StatusController; view: StatusView | null; actions: ChangesActions }) {
  const [, tick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const stop = controller.subscribe(() => {
      const wait = untitledCreateRemainingMs();
      if (wait === 0) {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        tick((n) => n + 1);
        return;
      }
      if (timer !== null) return;
      const fire = (): void => {
        timer = null;
        if (!alive) return;
        const left = untitledCreateRemainingMs();
        if (left > 0) {
          timer = window.setTimeout(fire, left);
          return;
        }
        tick((n) => n + 1);
      };
      timer = window.setTimeout(fire, wait);
    });
    return () => {
      alive = false;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      stop();
    };
  }, [controller]);
  const watched = controller.unchangedPath(view);
  const phase = controller.phase();
  useEffect(() => (watched === null ? undefined : controller.watchUnchanged(watched)), [controller, watched, phase]);
  const unread = controller.unreadPath(view);
  useEffect(() => {
    if (unread !== null) controller.readRow(unread);
  }, [controller, unread]);
  if (controller.phase() === "not-installed") return <NotInstalled actions={actions} />;
  const { model } = controller.build(view);
  return (
    <div class="sp-theme-obsidian specgit-status-panel" data-testid="status-panel">
      <StatusPanel model={model} host={controller.host} />
    </div>
  );
}
