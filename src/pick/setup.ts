import type { App, Modal, Plugin } from "obsidian";
import { type SpecgitApi, splitRepo } from "../api";
import { GIT_PROVIDER } from "../auth/config";
import type { Dialogs } from "../changes/flow-deps";
import { MARK_ICON } from "../brand/mark";
import { giveAccessUrl } from "../links";
import { isRepoName } from "../mapping";
import { showNotice, showNoticeWithAction } from "../notices";
import { bringForward, openDialogs } from "../brand/modal";
import { FolderConfirmModal, FolderSuggestModal } from "./folder-modals";
import { type PickerUi, RepoPicker } from "./flow";
import { readRepoList } from "./repo-list";
import { RepoSuggestModal } from "./repo-modal";
import type { CopyInFile } from "../changes/copy-in";
import { leftOutTotal } from "../changes/left-out";
import { CHOOSE_REPOSITORY, copyInLabel, copyInQuestion, copyInTitle, hiddenWords, leftOutWords, NOT_NOW, SETUP_CANCEL, SETUP_CONFIRM, SETUP_TITLE, setupQuestion, stayWith, SWITCH_LABEL, switchQuestion, switchTitle } from "./words";

export const SETUP_ACTION = "specgit-setup";

export interface PickDeps {
  api: SpecgitApi;
  dialogs: Dialogs;
  server: () => string;
  signedIn: () => boolean;
  signIn: () => Promise<void>;
  settings: () => { repo: string; folder: string };

  apply: (mapping: { repo: string; folder: string }) => Promise<void>;

  unsent: () => Promise<number | null>;

  copyIn: (files: readonly CopyInFile[], skipped?: readonly string[]) => Promise<void>;

  listing?: (repo: string) => Promise<{ commit: string | null; files: ReadonlyMap<string, string> } | null>;

  onboard?: () => void;
}

async function repoFiles(api: SpecgitApi, repo: string): Promise<string[] | null> {
  const named = splitRepo(repo);
  if (!named) return null;
  try {
    const answer = await api.call("GET", `/api/repos/${GIT_PROVIDER}/${named.owner}/${named.repo}/docs`);
    const docs = answer.status === 200 ? answer.body?.docs : undefined;
    if (!Array.isArray(docs)) return null;
    return docs.flatMap((doc: unknown) => (typeof doc === "object" && doc !== null && typeof (doc as { path?: unknown }).path === "string" ? [(doc as { path: string }).path] : []));
  } catch {
    return null;
  }
}

function obsidianUi(app: App, deps: PickDeps): PickerUi {

  let shown: Modal | null = null;
  const show = <T>(make: (answer: (value: T) => void) => Modal): Promise<T> =>
    new Promise<T>((resolve) => {
      const modal = make((value) => {
        if (shown === modal) shown = null;
        resolve(value);
      });
      shown = modal;
      modal.open();
    });

  const ask = (question: () => Promise<boolean>): Promise<boolean> => {
    const before = new Set(openDialogs());
    const answered = question();
    const mine = openDialogs().find((dialog) => !before.has(dialog)) ?? null;
    shown = mine;
    return answered.finally(() => {
      if (shown === mine) shown = null;
    });
  };
  const pickRepository = (): Promise<string | null> =>
    show<string | null>((answer) => {
      const { onboard } = deps;
      return new RepoSuggestModal(app, {

        ...(onboard && !isRepoName(deps.settings().repo)
          ? {
              onboard: () => {
                answer(null);
                onboard();
              },
            }
          : {}),
        load: () => readRepoList(deps.api, deps.signedIn),
        choose: (name) => answer(name),
        giveAccess: (repo) => window.open(giveAccessUrl(deps.server(), repo.fullName, repo.ownerInstallationId)),

        retry: () => void pickRepository().then(answer),
        dismissed: () => answer(null),
      });
    });
  return {
    pickRepository,
    confirmFolder: (question) => show((answer) => new FolderConfirmModal(app, question, answer)),
    pickFolder: () => show<string | null>((answer) => new FolderSuggestModal(app, app.vault.getAllFolders(false).map((folder) => folder.path), answer)),

    bringForward: () => (shown === null ? false : bringForward(shown)),
    confirmSetup: (repo) => ask(() => deps.dialogs.confirm({ title: SETUP_TITLE, description: setupQuestion(repo), confirmLabel: SETUP_CONFIRM, cancelLabel: SETUP_CANCEL })),
    confirmCopyIn: ({ repo, count, hidden, leftOut }) =>
      ask(() =>
        deps.dialogs.confirm({
          title: copyInTitle(repo),
          description: [copyInQuestion(repo, count), hidden > 0 ? hiddenWords(hidden) : "", leftOutTotal(leftOut) > 0 ? leftOutWords(leftOut) : ""].filter(Boolean).join(" "),
          confirmLabel: copyInLabel(count),
          cancelLabel: NOT_NOW,
        }),
      ),
    confirmSwitch: ({ from, to, unsent }) => ask(() => deps.dialogs.confirm({ title: switchTitle(to), description: switchQuestion(from, unsent), confirmLabel: SWITCH_LABEL, cancelLabel: stayWith(from) })),
  };
}

export function setUpPick(plugin: Plugin, deps: PickDeps): RepoPicker {
  const { app } = plugin;
  const picker = new RepoPicker({
    ui: obsidianUi(app, deps),
    settings: deps.settings,
    apply: deps.apply,
    repoFiles: (repo) => repoFiles(deps.api, repo),
    vaultPaths: () => app.vault.getFiles().map((file) => file.path),
    unsent: deps.unsent,
    copyIn: deps.copyIn,
    ...(deps.listing ? { listing: deps.listing } : {}),
    signedIn: deps.signedIn,
    signIn: deps.signIn,
    notify: showNotice,
    notifyWithAction: (message, label, run) => showNoticeWithAction(message, label, run),
  });
  plugin.addCommand({ id: "choose-repository", name: CHOOSE_REPOSITORY, icon: MARK_ICON, callback: () => void picker.chooseRepository() });
  plugin.registerObsidianProtocolHandler(SETUP_ACTION, (params) => void picker.setUp(params.repo));
  return picker;
}
