import type { Plugin } from "obsidian";

export type OnWindow = (target: Window | Document, type: string, run: (event: Event) => void, options?: AddEventListenerOptions) => void;

const running = new WeakMap<Plugin, Set<() => void>>();

function stopOnUnload(plugin: Plugin, stop: () => void): () => void {
  let stops = running.get(plugin);
  if (!stops) {
    const mine = new Set<() => void>();
    stops = mine;
    running.set(plugin, mine);
    plugin.register(() => {
      running.delete(plugin);
      for (const one of [...mine]) one();
    });
  }
  const held = stops;
  held.add(stop);
  return () => void held.delete(stop);
}

export function watchWindows(plugin: Plugin, attach: (win: Window, on: OnWindow) => void): () => void {
  const { workspace } = plugin.app;
  const removers = new Map<Window, Array<() => void>>();
  let stopped = false;
  const add = (win: Window): void => {
    if (stopped || removers.has(win)) return;
    const mine: Array<() => void> = [];
    removers.set(win, mine);
    attach(win, (target, type, run, options) => {
      target.addEventListener(type, run, options);
      mine.push(() => target.removeEventListener(type, run, options));
    });
  };
  const drop = (win: Window): void => {
    removers.get(win)?.forEach((remove) => remove());
    removers.delete(win);
  };
  add(window);
  workspace.iterateAllLeaves((leaf) => add(leaf.view.containerEl.win));
  const refs = [workspace.on("window-open", (_window, win) => add(win)), workspace.on("window-close", (_window, win) => drop(win))];
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    forget();
    for (const win of [...removers.keys()]) drop(win);
    for (const ref of refs) workspace.offref(ref);
  };
  const forget = stopOnUnload(plugin, stop);
  return stop;
}

export const appHidden = (): boolean => activeDocument.visibilityState === "hidden";
