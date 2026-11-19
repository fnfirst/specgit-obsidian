import type { Plugin } from "obsidian";
import { MARK_ICON } from "../brand/mark";
import { isRepoFile, type Place } from "../mapping";
import type { NotePhase, StatusBoard } from "../status";
import type { NoteFlows } from "./flow";

const OPEN_ITEM = "Open in specgit";
const COPY_LINK_ITEM = "Copy specgit link";

export interface CommandHost {

  openNote(): string | null;

  placeOf(path: string): Place;
  status: StatusBoard;
  flows: NoteFlows;
}

export function addNoteCommands(plugin: Plugin, host: CommandHost): void {
  const { flows, status } = host;
  const isNote = (path: string): boolean => host.placeOf(path).kind === "note";
  const hasAddress = (path: string): boolean => isRepoFile(host.placeOf(path));

  const forActiveFile = (id: string, name: string, is: (path: string) => boolean, applies: (phase: NotePhase) => boolean, run: (path: string) => void): void => {
    plugin.addCommand({
      id,
      name,
      icon: MARK_ICON,
      checkCallback: (checking) => {
        const path = host.openNote();
        if (path === null || !is(path) || !applies(status.phaseOf(path))) return false;
        if (!checking) run(path);
        return true;
      },
    });
  };
  forActiveFile("connect-live", "Connect Live", isNote, (phase) => phase === "local", (path) => void flows.connect(path));
  forActiveFile("disconnect", "Disconnect", isNote, (phase) => phase !== "local", (path) => flows.disconnect(path));
  forActiveFile("open-in-specgit", "Open in specgit", hasAddress, () => true, (path) => void flows.openInSpecgit(path));
  forActiveFile("copy-link", "Copy link", hasAddress, () => true, (path) => void flows.copyLink(path));

  plugin.registerEvent(
    plugin.app.workspace.on("file-menu", (menu, file) => {
      if (!hasAddress(file.path)) return;
      menu.addItem((item) =>
        item
          .setTitle(OPEN_ITEM)
          .setIcon(MARK_ICON)
          .onClick(() => void flows.openInSpecgit(file.path)),
      );
      menu.addItem((item) =>
        item
          .setTitle(COPY_LINK_ITEM)
          .setIcon(MARK_ICON)
          .onClick(() => void flows.copyLink(file.path)),
      );
    }),
  );
}
