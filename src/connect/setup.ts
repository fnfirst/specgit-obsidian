import type { Plugin } from "obsidian";
import type { Dialogs } from "../changes/flow-deps";
import type { SpecgitAccount } from "../account";
import type { Board } from "../board";
import type { Shown } from "../disk/regions";
import { noteUrl, openExternalUrl } from "../links";
import type { DocumentRef, Place } from "../mapping";
import { showNotice } from "../notices";
import type { OnboardingWatch, PanelComments } from "../panel/panel";
import { type PanelHandle, setUpPanel } from "../panel/setup";
import { showChanges } from "../review/modals";
import type { PollSignals } from "../shared/review-flow";
import type { StatusBoard } from "../status";
import { addNoteCommands } from "./commands";
import type { Connections } from "./connections";
import { NoteFlows } from "./flow";

export interface ConnectDeps {
  placeOf: (path: string) => Place;
  server: () => string;
  connections: Connections;
  status: StatusBoard;
  cameIn: Board<Shown[]>;
  account: SpecgitAccount;
  signedIn: () => boolean;
  signIn: () => Promise<void>;
  mapped: () => boolean;
  chooseRepository: () => void;
  onboard: () => void;
  continueUpload: () => void;
  onboarding: OnboardingWatch;
  repo: () => string;
  folder: () => string;
  stayConnected: () => boolean;
  setStayConnected: (on: boolean) => Promise<void>;
  peopleIn: (doc: DocumentRef) => Promise<number | null>;
  dialogs: Pick<Dialogs, "choose">;
  hasUnsentEdits: (path: string) => boolean;
  comments: PanelComments;
  disconnected?: () => void;
  tryNow?: () => void;
  signals?: PollSignals;
}

export async function ensureOpen(plugin: Plugin, path: string): Promise<void> {
  const { workspace, vault } = plugin.app;
  const shows = workspace.getLeavesOfType("markdown").find((leaf) => leaf.getViewState().state?.file === path);
  if (shows) return shows.loadIfDeferred();
  const file = vault.getFileByPath(path);
  if (file) await workspace.getLeaf("tab").openFile(file);
}

export function setUpConnect(plugin: Plugin, deps: ConnectDeps): PanelHandle {
  const { workspace } = plugin.app;
  const noteOpen = (): string | null => workspace.getActiveFile()?.path ?? null;
  const flows = new NoteFlows({
    placeOf: deps.placeOf,
    linked: () => ({ repo: deps.repo(), folder: deps.folder() }),
    connections: deps.connections,
    status: deps.status,
    signedIn: deps.signedIn,
    ensureOpen: (path) => ensureOpen(plugin, path),
    notify: showNotice,
    noteUrl: (doc) => noteUrl(deps.server(), doc),
    openUrl: (url) => void openExternalUrl(url, deps.server()),
    copyText: (text) => navigator.clipboard.writeText(text),
    disconnected: deps.disconnected,
    choose: (options) => deps.dialogs.choose(options),
    hasUnsentEdits: deps.hasUnsentEdits,
  });
  const panel = setUpPanel(
    plugin,
    { activeNote: noteOpen, placeOf: deps.placeOf, status: deps.status, cameIn: deps.cameIn, signedIn: deps.signedIn, mapped: deps.mapped, repo: deps.repo, folder: deps.folder, stayConnected: deps.stayConnected, peopleIn: deps.peopleIn, ...(deps.signals ? { signals: deps.signals } : {}) },
    {
      connect: (path) => void flows.connect(path),
      disconnect: (path) => flows.disconnect(path),
      signIn: () => void deps.signIn(),
      chooseRepository: deps.chooseRepository,
      onboard: deps.onboard,
      continueUpload: deps.continueUpload,
      onboarding: deps.onboarding,
      setStayConnected: (on) => void deps.setStayConnected(on),
      repo: deps.repo,
      ...(deps.tryNow ? { tryNow: deps.tryNow } : {}),
      openInSpecgit: (path) => void flows.openInSpecgit(path),
      copyLink: (path) => void flows.copyLink(path),
      seeChanges: (path) => {
        const shown = deps.cameIn.get(path);
        if (shown) showChanges(plugin.app, shown);
      },
    },
    deps.comments,
  );
  plugin.register(deps.account.onChange(() => panel.model.update()));
  addNoteCommands(plugin, { openNote: noteOpen, placeOf: deps.placeOf, status: deps.status, flows });
  return panel;
}
