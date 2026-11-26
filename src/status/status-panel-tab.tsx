import { useEffect, useRef, useState } from "preact/hooks";
import { onUntitledQuietEnd, untitledCreateRemainingMs } from "../changes/local-new";
import { StatusPanel, type StatusPanelModel } from "../shared/status-panel";
import { type ChangesActions, NotInstalled } from "./not-installed";
import type { StatusController, StatusView } from "./controller";

export function StatusPanelTab({ controller, view, actions }: { controller: StatusController; view: StatusView | null; actions: ChangesActions }) {
  const [, tick] = useState(0);
  const lastBuilt = useRef<{ controller: StatusController; model: StatusPanelModel } | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const clear = (): void => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
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
    const schedule = (): void => {
      if (!alive) return;
      const wait = untitledCreateRemainingMs();
      if (wait === 0) {
        clear();
        tick((n) => n + 1);
        return;
      }
      if (timer === null) timer = window.setTimeout(fire, wait);
    };
    scheduleRef.current = schedule;
    const stop = controller.subscribe(schedule);
    const stopQuiet = onUntitledQuietEnd(() => {
      if (!alive || timer === null || untitledCreateRemainingMs() > 0) return;
      clear();
      tick((n) => n + 1);
    });
    return () => {
      alive = false;
      scheduleRef.current = null;
      clear();
      stop();
      stopQuiet();
    };
  }, [controller]);
  const wait = untitledCreateRemainingMs();
  const deferBuild = wait > 0 && lastBuilt.current?.controller === controller;
  useEffect(() => {
    if (deferBuild) scheduleRef.current?.();
  }, [deferBuild, view]);
  const watched = deferBuild ? null : controller.unchangedPath(view);
  const phase = controller.phase();
  useEffect(() => (watched === null ? undefined : controller.watchUnchanged(watched)), [controller, watched, phase]);
  const unread = deferBuild ? null : controller.unreadPath(view);
  useEffect(() => {
    if (unread !== null) controller.readRow(unread);
  }, [controller, unread]);
  if (phase === "not-installed") return <NotInstalled actions={actions} />;
  let model: StatusPanelModel;
  if (deferBuild) {
    model = lastBuilt.current!.model;
  } else {
    model = controller.build(view).model;
    lastBuilt.current = { controller, model };
  }
  return (
    <div class="sp-theme-obsidian specgit-status-panel" data-testid="status-panel">
      <StatusPanel model={model} host={controller.host} />
    </div>
  );
}
