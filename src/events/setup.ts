import type { Plugin } from "obsidian";
import type { SpecgitApi } from "../api";
import { LiveEvents } from "./client";
import { appHidden, watchWindows } from "../windows";

export interface EventsSetup {
  api: SpecgitApi;

  repo: () => string;
  signedIn: () => boolean;
}

export function setUpEvents(plugin: Plugin, deps: EventsSetup): LiveEvents {
  const events = new LiveEvents({
    api: deps.api,
    repo: deps.repo,
    signedIn: deps.signedIn,
    hidden: appHidden,

    onWake: (wake) =>
      watchWindows(plugin, (win, on) => {
        on(win.document, "visibilitychange", () => {
          if (!appHidden()) wake();
        });
        on(win, "focus", wake);
      }),
    later: (run, ms) => {
      const id = window.setTimeout(run, ms);
      return () => window.clearTimeout(id);
    },
  });
  plugin.register(events.start());
  return events;
}
