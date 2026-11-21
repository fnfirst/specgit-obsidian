import type { BlobsAnswer } from "../auth/git-copy";
import { clientPollOffset, createPollGateFor, GROUP_PRO_ONLY, type LiveEvent } from "../shared/review-flow";
import { Platform, type Plugin, TFile } from "obsidian";
import type { SpecgitApi } from "../api";
import { NOTE_BRANCH } from "../auth/config";
import { giveAccessUrl } from "../links";
import type { BaseStore } from "../disk/bases";
import { guardedVault } from "../disk/guarded-vault";
import { trashOption } from "../disk/obsidian-config";
import type { NotePhase } from "../status";
import { changesBetween } from "../disk/merge";
import { cameInWords, changesIn } from "../disk/regions";
import { toLf } from "../disk/line-endings";
import { type DocumentRef, fileFor, LISTED_FILE, type MappingSettings, normalizeFolder, underFolder } from "../mapping";
import { pageSignals } from "../comments/setup";
import { showNoticeWithAction } from "../notices";
import type { PanelTabs } from "../panel/panel";
import { nativeHost } from "../status/host";
import { SinceView, StatusController } from "../status/controller";
import { StatusPanelTab } from "../status/status-panel-tab";
import type { BroughtDraft } from "./bring-in";
import { chooseWhatToKeep, showChanges } from "../review/modals";
import { ReviewApi } from "../review/review-api";
import type { BranchFile, MainFile } from "../auth/git-copy";
import { FileCache } from "./cache";
import type { CopyInFile } from "./copy-in";
import { writeIfHolds } from "./guarded-write";
import { openNote } from "./open-note";
import { keepGitBase } from "./main-base";
import { DISCARD } from "./discard-words";
import type { Dialogs } from "./flow-deps";
import { ChangesFlows } from "./flows";
import { FILES_PER_BATCH } from "./copy-in";
import { gitBlobSha } from "./blob-sha";
import { collectAttachments } from "./collect-attachments";
import { attachmentRenamed, RENAME_LOOKS_AFTER_MS } from "./attachment-rename";
import { LiveFiles } from "./live-files";
import { type Attachment, AttachmentMemory } from "./attachment-memory";
import { MirrorClient } from "./mirror";
import { ReviewEvents } from "./review-events";
import { sameAsRepo } from "./same-text";
import { CHECK_EVERY_MS, restingSignals, Watch } from "./watch";
import { ChangesModel } from "./model";
import type { OwnRestarts } from "../room/own-restarts";
import { appHidden, watchWindows } from "../windows";

export interface ChangesSetup {
  api: SpecgitApi;
  settings: () => MappingSettings;
  bases: BaseStore;
  gitCopy: (doc: DocumentRef) => Promise<string | null>;
  gitFile: (doc: DocumentRef) => Promise<MainFile>;
  gitBlobs?: (repo: string, commit: string | null, files: ReadonlyArray<{ sha: string; path: string }>, byBlob?: boolean) => Promise<BlobsAnswer>;
  branchFile: (doc: DocumentRef, branch: string) => Promise<BranchFile>;
  gitBlob: (doc: DocumentRef, sha: string) => Promise<string | null>;
  signedIn: () => boolean;
  viewerLogin: () => string;
  phaseOf: (path: string) => NotePhase;
  othersHere: (path: string) => number;
  ownRestarts: Pick<OwnRestarts, "expect" | "sent" | "done">;
  server: () => string;
  openInSpecgit: (path: string) => void;
  openComments?: (path: string) => number;
  deletedOnMain?: (path: string) => boolean;
  isLive: (path: string) => boolean;
  copyIn?: (files: readonly CopyInFile[], skipped?: readonly string[]) => Promise<unknown>;
  dialogs: Dialogs;
  live?: () => boolean;
  stayOn?: () => boolean;
  stopped?: (path: string) => void;
  deleted?: (path: string, at: number) => void;
  deletedAt?: (path: string) => number | null;
  restored?: (path: string) => void;
  touchNote?: (path: string) => void;
  bringFor?: (path: string, text: string) => Promise<void>;
  attachmentProblems?: (path: string, problems: ReadonlyArray<{ name: string; why: string }>) => void;
  heldWhy?: (path: string) => string | null;
  join?: (path: string) => void;
  addToMyNote?: (path: string) => void;
  offered?: () => readonly string[];
  addOffered?: () => void;
  bringInNewer?: () => Promise<unknown>;
  bringInDraft?: (path: string) => Promise<BroughtDraft>;
}

const LOOK_AFTER_MS = 1_500;

const base64Of = (buffer: ArrayBuffer): string => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return window.btoa(binary);
};

export function setUpChanges(plugin: Plugin, deps: ChangesSetup): PanelTabs & { model: ChangesModel; flows: ChangesFlows; review: ReviewApi; settingsChanged: () => void; attachments: () => AttachmentMemory; liveFiles: LiveFiles; live: { heard: (event: LiveEvent) => void; catchUp: (first?: boolean) => void } } {
  const { app } = plugin;
  const repo = (): string => deps.settings().repo;
  const folder = (): string => normalizeFolder(deps.settings().folder);
  const mapped = (path: string): DocumentRef | null => fileFor(deps.settings(), path);
  const review = new ReviewApi(deps.api);
  const placeKey = (): string => `${repo()}\n${folder()}`;
  let lookedAt = placeKey();
  let current: { key: string; cache: FileCache; mirror: MirrorClient; attachments: AttachmentMemory } | null = null;
  const placed = (): { cache: FileCache; mirror: MirrorClient; attachments: AttachmentMemory } => {
    const key = placeKey();
    if (current?.key !== key) {
      const left = current;
      const cache = new FileCache(key, { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) });
      if (left) cache.inherit(new Map([...left.cache.foreignFiles(), ...left.cache.matchedFiles()]));
      current = { key, cache, mirror: new MirrorClient(deps.api, repo(), folder(), { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) }), attachments: new AttachmentMemory(key, { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) }) };
    }
    return current;
  };
  const activePath = (): string | null => app.workspace.getActiveFile()?.path ?? null;
  const fetched = new Map<string, string>();
  const model = new ChangesModel({
    prefetchBlobs: async (reads) => {
      fetched.clear();
      if (!deps.gitBlobs) return;
      for (let at = 0; at < reads.length; at += FILES_PER_BATCH) {
        const run = reads.slice(at, at + FILES_PER_BATCH);
        const answer = await deps.gitBlobs(run[0]!.doc.repo, null, run.map(({ doc, sha }) => ({ sha, path: doc.path })), true);
        if (answer.kind !== "answered") return;
        for (const { sha } of run) {
          const read = answer.files.get(sha);
          if (read?.kind === "text") fetched.set(sha, read.text);
        }
      }
    },
    sameAsRepo: (path, doc, sha, repoSha, mayRead) =>
      sameAsRepo(
        {
          readBytes: async (one) => {
            const file = app.vault.getFileByPath(one);
            return file ? app.vault.readBinary(file).catch(() => null) : null;
          },
          readBlob: async (doc, sha) => fetched.get(sha) ?? deps.gitBlob(doc, sha),
        },
        path,
        doc,
        sha,
        repoSha,
        mayRead,
      ),
    listFiles: () => app.vault.getFiles().map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size })),
    readBytes: async (path) => {
      const file = app.vault.getFileByPath(path);
      if (!file) throw new Error("gone");
      return app.vault.readBinary(file);
    },
    get cache() {
      return placed().cache;
    },
    get mirror() {
      return placed().mirror;
    },
    place: () => placeKey(),
    review,
    groups: () => review.groups(repo()),
    presence: () => review.presence(repo()),
    vaultPath: (path) => placed().mirror.vaultPath(path),
    documentFor: mapped,
    activePath,
    viewerLogin: deps.viewerLogin,
    signedIn: deps.signedIn,
    openComments: (path) => deps.openComments?.(path) ?? 0,
    deletedOnMain: (path) => deps.deletedOnMain?.(path) === true,
    heldWhy: (path) => deps.heldWhy?.(path) ?? null,
    isLive: (path) => deps.isLive(path),
  });
  const repoPathOf = (path: string): string | null => underFolder(folder(), path);
  const attachmentsOf = async (path: string): Promise<Attachment[]> => {
    const file = app.vault.getFileByPath(path);
    if (!file) return [];
    const text = await app.vault.read(file);
    const memory = placed().attachments;
    const bytesOf = async (one: { path: string }): Promise<ArrayBuffer> => {
      const target = app.vault.getFileByPath(one.path);
      if (!target) throw new Error("gone");
      return app.vault.readBinary(target);
    };
    return collectAttachments(
      {
        resolve: (link, from) => {
          const target = app.metadataCache.getFirstLinkpathDest(link, from);
          return target ? { path: target.path, mtime: target.stat.mtime, size: target.stat.size } : null;
        },
        repoPathOf,
        sha: (one) => memory.hash(one.path, { mtime: one.mtime, size: one.size }, async () => gitBlobSha(await bytesOf(one))),
        base64: async (one) => base64Of(await bytesOf(one)),
        agreedOf: (repoPath) => memory.agreedOf(repoPath),
        publishedSha: (vaultPath) => model.attachmentSha(vaultPath),
      },
      path,
      text,
    );
  };
  const vault = guardedVault(app);
  const since = new SinceView();
  const flows = new ChangesFlows({
    review,
    model,
    dialogs: deps.dialogs,
    readText: async (path) => {
      const file = app.vault.getFileByPath(path);
      return file ? app.vault.read(file) : null;
    },
    writeText: async (path, text, expected) => {
      const file = app.vault.getFileByPath(path);
      if (!(file instanceof TFile)) return false;
      const before = toLf(await app.vault.read(file));
      if (!(await writeIfHolds((edit) => app.vault.process(file, edit), expected, text))) return false;
      const shown = changesBetween(before, toLf(text));
      if (shown) showNoticeWithAction(cameInWords(changesIn(shown)), "See changes", () => showChanges(app, shown));
      return true;
    },
    vault,
    phaseOf: deps.phaseOf,
    othersHere: deps.othersHere,
    ownRestarts: deps.ownRestarts,
    hasRoomBase: (path) => {
      const read = deps.bases.read(path);
      return read.status === "found" && read.base.room !== null;
    },
    keepBase: (path, doc, raw) => keepGitBase(deps.bases, path, doc, raw),
    deletesForGood: () => trashOption(app) === "none",
    gitCopy: deps.gitCopy,
    gitFile: deps.gitFile,
    ...(deps.gitBlobs ? { gitBlobs: deps.gitBlobs } : {}),
    branchFile: deps.branchFile,
    gitBlob: deps.gitBlob,
    baseText: (path) => {
      const read = deps.bases.read(path);
      return read.status === "found" && read.base.room === null ? read.base.text : null;
    },
    sentCommit: (path) => placed().cache.get(path)?.sentCommit,
    chooseWhatToKeep: (request) => chooseWhatToKeep(app, request),
    attachments: attachmentsOf,
    attachmentTold: (path, words) => model.attachmentTold(path, words),
    attachmentHeld: (repoPath, sha) => placed().attachments.agreedOf(repoPath) === sha,
    ...(deps.bringFor ? { bringFor: deps.bringFor } : {}),
    attachmentAgreed: (repoPath, sha) => placed().attachments.agree(repoPath, sha),
    ...(deps.attachmentProblems ? { attachmentProblems: deps.attachmentProblems } : {}),
    documentFor: mapped,
    viewerLogin: deps.viewerLogin,
    candidates: (doc) => review.reviewers(doc),
    openComments: (path) => deps.openComments?.(path) ?? 0,
    showChanges: (shown, context) => {
      const yours = context.kind === "yours";
      const modal = showChanges(app, shown, context, yours ? () => since.closed() : undefined);
      if (yours) since.opened(() => modal.close());
    },
    publishedBranch: NOTE_BRANCH,
    ...(deps.stopped ? { stopped: deps.stopped } : {}),
    ...(deps.deleted ? { deleted: deps.deleted } : {}),
    ...(deps.deletedAt ? { deletedAt: deps.deletedAt } : {}),
    ...(deps.restored ? { restored: deps.restored } : {}),
  });
  const actions = {
    openNote: (path: string, event?: MouseEvent | KeyboardEvent) => openNote(app, path, event),
    openUrl: (url: string) => void window.open(url),
    openInSpecgit: deps.openInSpecgit,
    owner: () => repo().split("/")[0] ?? "",
    repo,
    folder,
    isLive: (path: string) => deps.isLive(path),
    giveAccess: () => void window.open(giveAccessUrl(deps.server(), repo())),
    copyIn: async () => void (await deps.copyIn?.(model.missingFiles(), model.missingSkipped())),
    ...(deps.join ? { join: deps.join } : {}),
    ...(deps.addToMyNote ? { addToMyNote: deps.addToMyNote } : {}),
    ...(deps.offered ? { offered: deps.offered } : {}),
    ...(deps.addOffered ? { addOffered: deps.addOffered } : {}),
  };

  const host = nativeHost(app);
  const status = new StatusController({
    model,
    flows,
    review,
    dialogs: deps.dialogs,
    viewer: deps.viewerLogin,
    repo,
    folder,
    place: placeKey,
    activePath,
    storage: { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) },
    note: { open: (path) => openNote(app, path), openInSpecgit: deps.openInSpecgit, openUrl: actions.openUrl, ...(deps.join ? { join: deps.join } : {}) },
    copyIn: actions.copyIn,
    bringInNewer: () => deps.bringInNewer?.() ?? Promise.resolve(),
    bringInDraft: (path) => deps.bringInDraft?.(path) ?? Promise.resolve({ kind: "none" as const }),
    inVault: (path) => app.vault.getFileByPath(path) !== null,
    isLive: (path) => deps.isLive(path),
    openComments: (path) => deps.openComments?.(path) ?? 0,
    ...(deps.offered ? { offered: deps.offered } : {}),
    ...(deps.addOffered ? { addOffered: deps.addOffered } : {}),
    documentFor: mapped,
    ask: host.confirm,
    openMenu: host.openMenu,
    touch: Platform.isMobile,
    since,
    plansUrl: () => `${deps.server().replace(/\/+$/, "")}${GROUP_PRO_ONLY.upgradePath}`,
  });
  plugin.register(() => status.dispose());

  let timer: number | undefined;
  const lookSoon = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void model.refresh(), LOOK_AFTER_MS);
  };
  const watch = (file: { path: string }): void => {
    if (!LISTED_FILE.test(file.path)) return;
    unquiet();
    lookSoon();
  };
  plugin.registerEvent(app.vault.on("create", watch));
  const liveFiles = new LiveFiles({
    isLive: (path) => deps.isLive(path),
    later: (run, ms) => {
      const timer = window.setTimeout(run, ms);
      return () => window.clearTimeout(timer);
    },
    read: async (path) => {
      const file = app.vault.getFileByPath(path);
      return file ? app.vault.read(file) : null;
    },
    bring: (path, text) => deps.bringFor?.(path, text) ?? Promise.resolve(),
    send: (path) => flows.sendLiveFiles(path),
  });
  plugin.registerEvent(app.vault.on("modify", (file) => (/\.md$/i.test(file.path) ? liveFiles.changed(file.path) : undefined)));
  plugin.register(() => liveFiles.dispose());
  const renames = new Set<number>();
  plugin.registerEvent(
    app.vault.on("rename", (file) => {
      if (LISTED_FILE.test(file.path) || underFolder(folder(), file.path) === null) return;
      const timer = window.setTimeout(() => {
        renames.delete(timer);
        attachmentRenamed(
          { resolved: () => app.metadataCache.resolvedLinks, isLive: (path) => deps.isLive(path), live: (path) => liveFiles.joined(path), local: (path) => deps.touchNote?.(path) },
          file.path,
        );
      }, RENAME_LOOKS_AFTER_MS);
      renames.add(timer);
    }),
  );
  plugin.register(() => renames.forEach((timer) => window.clearTimeout(timer)));
  plugin.registerEvent(app.vault.on("modify", watch));
  plugin.registerEvent(app.vault.on("delete", watch));
  plugin.registerEvent(app.vault.on("rename", watch));
  const signals = pageSignals(plugin, deps.live);
  const watcher = new Watch({ signals, moved: () => placed().mirror.moved(), live: () => deps.live?.() === true, look: lookSoon, stay: () => deps.stayOn?.() === true });
  const unquiet = (): void => watcher.unquiet();
  plugin.register(
    model.onLooked((looked) => {
      watcher.looked(looked === null ? "off" : `${looked.repo.size}|${looked.rows.map((row) => `${row.change.path}:${row.change.sha}:${row.entry?.prNumber ?? 0}:${row.entry?.isDraft ?? ""}`).join(",")}`);
    }),
  );
  const resumed = (): void => {
    if (appHidden()) return;
    unquiet();
    lookSoon();
    void model.refreshPresence();
    status.reviewsChanged();
  };
  watchWindows(plugin, (win, on) => {
    on(win.document, "visibilitychange", resumed);
    on(win, "focus", resumed);
  });
  const first = window.setTimeout(() => plugin.registerInterval(window.setInterval(() => void watcher.tick(), CHECK_EVERY_MS)), clientPollOffset(CHECK_EVERY_MS));
  plugin.register(() => window.clearTimeout(first));
  plugin.register(() => window.clearTimeout(timer));
  plugin.register(() => model.dispose());
  const reviewEvents = new ReviewEvents();
  const reaction = createPollGateFor(restingSignals(signals, () => deps.stayOn?.() === true)).reaction(({ expireReviews }) => {
    if (expireReviews) {
      model.expireReviews(reviewEvents.named(Date.now()));
      status.reviewsChanged();
    }
    unquiet();
    lookSoon();
  });
  plugin.register(reaction.start());
  app.workspace.onLayoutReady(() => void model.refresh());
  plugin.addCommand({
    id: "discard-all",
    name: DISCARD.command,
    checkCallback: (checking) => {
      if (model.state().busy) return false;
      if (!checking) void flows.discard(model.state().rows);
      return true;
    },
  });

  return {
    model,
    flows,
    review,
    liveFiles,
    attachments: () => placed().attachments,
    settingsChanged: () => {
      void model.refreshPresence(true);
      if (placeKey() === lookedAt) return;
      lookedAt = placeKey();
      lookSoon();
    },
    subscribe: (listener) => {
      const stops = [model.subscribe(listener), status.subscribe(listener)];
      return () => stops.forEach((stop) => stop());
    },
    live: {
      heard: (event) => {
        if (event.kind === "presence") return void model.refreshPresence();
        reviewEvents.heard(event, Date.now());
        reaction.heard(event);
      },
      catchUp: (first = false) => {
        reaction.catchUp(first);
        void model.refreshPresence(true);
        status.reviewsChanged();
      },
    },
    contents: (view) => ({ status: <StatusPanelTab controller={status} view={view ?? null} actions={actions} /> }),
    badges: () => ({ comments: { open: 0 } }),
  };
}
