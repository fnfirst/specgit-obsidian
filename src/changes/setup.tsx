import type { SpecgitBinaryFetch } from "../auth/binary-fetch";
import type { BlobsAnswer } from "../auth/git-copy";
import { clientPollOffset, createPollGateFor, GROUP_PRO_ONLY, type LiveEvent, type PollSignals } from "../shared/review-flow";
import { Platform, type Plugin, TFile } from "obsidian";
import type { SpecgitApi } from "../api";
import { NOTE_BRANCH } from "../auth/config";
import { giveAccessUrl, openExternalUrl } from "../links";
import type { BaseStore } from "../disk/bases";
import { guardedVault } from "../disk/guarded-vault";
import { hashVaultBinary, readVaultBinaryBlob } from "../disk/vault-binary";
import { trashOption } from "../disk/obsidian-config";
import type { NotePhase } from "../status";
import { changesBetween } from "../disk/merge";
import { cameInWords, changesIn } from "../disk/regions";
import { stripBom, toLf } from "../disk/line-endings";
import { type DocumentRef, fileFor, LISTED_FILE, type MappingSettings, normalizeFolder, underFolder } from "../mapping";
import { pageSignals } from "../comments/setup";
import { showNoticeWithAction } from "../notices";
import type { PanelTabs } from "../panel/panel";
import { nativeHost } from "../status/host";
import { SinceView, StatusController } from "../status/controller";
import type { GithubStatusReader } from "../status/github-status";
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
import { fileAttachmentLinks } from "./attachment-links";
import type { AttachmentQuery, Dialogs } from "./flow-deps";
import { ChangesFlows } from "./flows";
import { FILES_PER_BATCH } from "./copy-in";
import { collectAttachments } from "./collect-attachments";
import { attachmentRenamed, RENAME_LOOKS_AFTER_MS } from "./attachment-rename";
import { deferDuringUntitled, isFreshUntitled, untitledCreateRemainingMs } from "./local-new";
import { LiveFiles } from "./live-files";
import { type Attachment, AttachmentMemory } from "./attachment-memory";
import { MirrorClient } from "./mirror";
import type { OwnLinks } from "./own-links";
import { ReviewEvents } from "./review-events";
import type { ReviewKey } from "./review-key";
import { BLOB_CACHE_MAX, BlobCache, sameAsRepo } from "./same-text";
import { sentBaseFor, type SentRecord } from "./sent-memory";
import { CHECK_EVERY_MS, restingSignals, Watch, watchSignature } from "./watch";
import { ChangesModel } from "./model";
import { type IgnoreAdapter, VaultIgnore } from "../onboard/ignore";
import type { OwnRestarts } from "../room/own-restarts";
import { appHidden, watchWindows } from "../windows";

export interface ChangesSetup {
  api: SpecgitApi;
  binary?: Pick<SpecgitBinaryFetch, "uploadAttachment">;
  settings: () => MappingSettings;
  bases: BaseStore;
  gitCopy: (doc: DocumentRef) => Promise<string | null>;
  gitFile: (doc: DocumentRef) => Promise<MainFile>;
  gitBlobs?: (repo: string, commit: string | null, files: ReadonlyArray<{ sha: string; path: string }>, byBlob?: boolean) => Promise<BlobsAnswer>;
  branchFile: (doc: DocumentRef, branch: string) => Promise<BranchFile>;
  gitBlob: (doc: DocumentRef, sha: string, signal?: AbortSignal) => Promise<string | null>;
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
  signals?: PollSignals;
  stayOn?: () => boolean;
  isPaused?: (path: string) => boolean;
  stopped?: (path: string) => void;
  deleted?: (path: string, at: number) => void;
  deletedAt?: (path: string) => number | null;
  restored?: (path: string) => void;
  conflictResolved?: (path: string) => void;
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
  ownLinks?: OwnLinks;
  githubStatus?: GithubStatusReader;
  isOwnWrite?: (path: string) => boolean;
}

export const LOOK_DEBOUNCE_MS = 1_500;
export const MAX_LOOK_WAIT_MS = 3_500;
export const OWN_WRITE_LOOK_MS = 4_000;
const UNTITLED_LOOK_PAD_MS = 50;
export const RESUME_FLOOR_MS = 30_000;

const pluginOwnWrites = new WeakMap<Plugin, (path: string) => boolean>();

export function registerPluginOwnWrites(plugin: Plugin, check: (path: string) => boolean): () => void {
  pluginOwnWrites.set(plugin, check);
  return () => {
    if (pluginOwnWrites.get(plugin) === check) pluginOwnWrites.delete(plugin);
  };
}

const base64Of = (buffer: ArrayBuffer): string => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return window.btoa(binary);
};

function ignoreAdapterOf(vault: { adapter?: unknown }): IgnoreAdapter | null {
  const candidate = vault.adapter;
  if (typeof candidate !== "object" || candidate === null) return null;
  const stat = Reflect.get(candidate, "stat") as unknown;
  const read = Reflect.get(candidate, "read") as unknown;
  if (typeof stat !== "function" || typeof read !== "function") return null;
  return {
    stat: (path) => (stat as IgnoreAdapter["stat"]).call(candidate, path),
    read: (path) => (read as IgnoreAdapter["read"]).call(candidate, path),
  };
}

export function setUpChanges(plugin: Plugin, deps: ChangesSetup): PanelTabs & { model: ChangesModel; flows: ChangesFlows; review: ReviewApi; settingsChanged: () => void; attachments: () => AttachmentMemory; liveFiles: LiveFiles; sentBase: (path: string, doc: DocumentRef, since?: number, signal?: AbortSignal) => Promise<string | null> | null; live: { heard: (event: LiveEvent) => void; catchUp: (first?: boolean) => void } } {
  const { app } = plugin;
  const repo = (): string => deps.settings().repo;
  const folder = (): string => normalizeFolder(deps.settings().folder);
  const mapped = (path: string): DocumentRef | null => fileFor(deps.settings(), path);
  const review = new ReviewApi(deps.api, deps.binary);
  const sentText = new Map<string, SentRecord>();
  const heldCommits = new Set<string>();
  const placeKey = (): string => `${repo()}\n${folder()}`;
  let lookedAt = placeKey();
  let current: { key: string; cache: FileCache; mirror: MirrorClient; attachments: AttachmentMemory } | null = null;
  const placed = (): { cache: FileCache; mirror: MirrorClient; attachments: AttachmentMemory } => {
    const key = placeKey();
    if (current?.key !== key) {
      const left = current;
      left?.cache.flush();
      sentText.clear();
      heldCommits.clear();
      const cache = new FileCache(key, { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) });
      if (left) cache.inherit(new Map([...left.cache.foreignFiles(), ...left.cache.matchedFiles()]));
      current = { key, cache, mirror: new MirrorClient(deps.api, repo(), folder(), { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) }), attachments: new AttachmentMemory(key, { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) }) };
    }
    return current;
  };
  const activePath = (): string | null => app.workspace.getActiveFile()?.path ?? null;
  const fetched = new BlobCache(BLOB_CACHE_MAX);
  const blobKey = (repoName: string, sha: string): string => `${repoName}\n${sha}`;
  const vaultIgnore = new VaultIgnore(ignoreAdapterOf(app.vault));
  const model = new ChangesModel({
    prefetchBlobs: async (reads) => {
      if (!deps.gitBlobs) return;
      const missing: Array<{ doc: DocumentRef; sha: string }> = [];
      const seen = new Set<string>();
      for (const read of reads) {
        const key = blobKey(read.doc.repo, read.sha);
        if (fetched.has(key) || seen.has(key)) continue;
        seen.add(key);
        missing.push(read);
      }
      for (let at = 0; at < missing.length; at += FILES_PER_BATCH) {
        const run = missing.slice(at, at + FILES_PER_BATCH);
        const answer = await deps.gitBlobs(run[0]!.doc.repo, null, run.map(({ doc, sha }) => ({ sha, path: doc.path })), true);
        if (answer.kind !== "answered") return;
        for (const { doc, sha } of run) {
          const read = answer.files.get(sha);
          if (read?.kind === "text") fetched.set(blobKey(doc.repo, sha), read.text);
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
          readBlob: async (doc, sha) => {
            const key = blobKey(doc.repo, sha);
            const hit = fetched.get(key);
            if (hit !== undefined) return hit;
            const text = await deps.gitBlob(doc, sha);
            if (text !== null) fetched.set(key, text);
            return text;
          },
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
    refreshIgnore: () => vaultIgnore.refresh(),
    isIgnored: (path) => vaultIgnore.isIgnored(path),
  });
  const repoPathOf = (path: string): string | null => underFolder(folder(), path);
  const ownOnly = (path: string): ((link: string) => boolean) => (link) => deps.ownLinks?.has(path, link) === true;
  const mineFor = async (path: string, links: readonly string[], query: AttachmentQuery): Promise<(link: string) => boolean> => {
    if (deps.isLive(path)) return ownOnly(path);
    const known: string[] = [...(query.baselines ?? [])];
    const stored = deps.bases.read(path);
    if (stored.status === "found") known.push(stored.base.text);
    const cacheEntry = placed().cache.get(path);
    const draft = model.draftFor(path);
    const theirs = model.theirReview(path);
    const row = model.row(path);
    const onMain = model.vault()?.files.get(path)?.repoSha != null;
    const tracked =
      onMain ||
      cacheEntry?.base != null ||
      cacheEntry?.sent !== undefined ||
      draft !== undefined ||
      theirs !== undefined ||
      row?.review?.reviewBranch != null ||
      stored.status !== "none";
    const doc = mapped(path);
    const branch = query.branch !== undefined ? query.branch : (draft?.branch ?? theirs?.branch ?? row?.review?.reviewBranch ?? null);
    if (query.baselines === undefined) {
      if (!doc || branch === null) return ownOnly(path);
      const [branchResult, mainCopy] = await Promise.all([
        deps.branchFile(doc, branch).catch((): BranchFile => ({ kind: "unreadable" })),
        onMain ? deps.gitCopy(doc).catch(() => null) : Promise.resolve<string | null>(null),
      ]);
      if (branchResult.kind === "unreadable") return ownOnly(path);
      if (onMain && mainCopy === null && stored.status !== "found") return ownOnly(path);
      if (branchResult.kind === "file") known.push(branchResult.text);
      if (mainCopy !== null) known.push(mainCopy);
    } else if (branch !== null) {
      if (!doc) return ownOnly(path);
      const branchResult = await deps.branchFile(doc, branch).catch((): BranchFile => ({ kind: "unreadable" }));
      if (branchResult.kind === "unreadable") return ownOnly(path);
      if (branchResult.kind === "file") known.push(branchResult.text);
    }
    if (!tracked && known.length === 0) return () => true;
    if (known.length === 0) return ownOnly(path);
    const baselineLinks = new Set<string>();
    for (const copy of known) for (const link of fileAttachmentLinks(path, copy)) baselineLinks.add(link);
    const authored = links.filter((link) => !baselineLinks.has(link));
    if (authored.length > 0) deps.ownLinks?.added(path, authored);
    return (link) => deps.ownLinks?.has(path, link) === true || !baselineLinks.has(link);
  };
  const attachmentsOf = async (path: string, query?: AttachmentQuery): Promise<Attachment[]> => {
    const file = app.vault.getFileByPath(path);
    if (!file) return [];
    const text = await app.vault.read(file);
    await vaultIgnore.refresh();
    const memory = placed().attachments;
    const bytesOf = async (one: { path: string }): Promise<ArrayBuffer> => {
      const target = app.vault.getFileByPath(one.path);
      if (!target) throw new Error("gone");
      return app.vault.readBinary(target);
    };
    const links = query?.onlyMine ? fileAttachmentLinks(path, text) : [];
    const mine = query?.onlyMine && links.length > 0 ? await mineFor(path, links, query) : undefined;
    return collectAttachments(
      {
        resolve: (link, from) => {
          const target = app.metadataCache.getFirstLinkpathDest(link, from);
          if (!target) return null;
          const targetRepoPath = repoPathOf(target.path);
          const published = model.attachmentSha(target.path);
          const heldOnGitHub = (targetRepoPath !== null && memory.agreedOf(targetRepoPath) !== undefined) || (published !== undefined && published !== null);
          if (!heldOnGitHub && vaultIgnore.isIgnored(target.path)) return null;
          return { path: target.path, mtime: target.stat.mtime, size: target.stat.size };
        },
        repoPathOf,
        sha: (one) => memory.hash(one.path, { mtime: one.mtime, size: one.size }, () => hashVaultBinary(app, one.path, one.size)),
        binary: (one) => readVaultBinaryBlob(app, one.path),
        base64: async (one) => base64Of(await bytesOf(one)),
        agreedOf: (repoPath) => memory.agreedOf(repoPath),
        publishedSha: (vaultPath) => model.attachmentSha(vaultPath),
        ...(mine ? { mine } : {}),
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
    readText: (path) => vault.read(path),
    writeText: async (path, text, expected) => {
      const file = app.vault.getFileByPath(path);
      if (!(file instanceof TFile)) return false;
      const before = stripBom(toLf((await vault.read(path)) ?? ""));
      let written = "";
      if (!(await writeIfHolds((edit) => app.vault.process(file, edit), expected, text, (saved) => void (written = saved)))) return false;
      const shown = changesBetween(before, stripBom(toLf(written)));
      if (shown) showNoticeWithAction(cameInWords(changesIn(shown)), "See changes", () => showChanges(app, shown));
      return written;
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
    sentText,
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
    ...(deps.conflictResolved ? { conflictResolved: deps.conflictResolved } : {}),
  });
  const actions = {
    openNote: (path: string, event?: MouseEvent | KeyboardEvent) => openNote(app, path, event),
    openUrl: (url: string) => void openExternalUrl(url, deps.server()),
    openInSpecgit: deps.openInSpecgit,
    owner: () => repo().split("/")[0] ?? "",
    repo,
    folder,
    isLive: (path: string) => deps.isLive(path),
    giveAccess: () => void openExternalUrl(giveAccessUrl(deps.server(), repo()), deps.server()),
    copyIn: async () => void (await deps.copyIn?.(model.missingFiles(), model.missingSkipped())),
    ...(deps.join ? { join: deps.join } : {}),
    ...(deps.addToMyNote ? { addToMyNote: deps.addToMyNote } : {}),
    ...(deps.offered ? { offered: deps.offered } : {}),
    ...(deps.addOffered ? { addOffered: deps.addOffered } : {}),
  };

  const host = nativeHost(app);
  const isOwnWrite = (path: string): boolean => deps.isOwnWrite?.(path) === true || pluginOwnWrites.get(plugin)?.(path) === true;
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
    ...(deps.stayOn ? { stayOn: deps.stayOn } : {}),
    ...(deps.isPaused ? { isPaused: deps.isPaused } : {}),
    openComments: (path) => deps.openComments?.(path) ?? 0,
    ...(deps.offered ? { offered: deps.offered } : {}),
    ...(deps.addOffered ? { addOffered: deps.addOffered } : {}),
    documentFor: mapped,
    ask: host.confirm,
    openMenu: host.openMenu,
    touch: Platform.isMobile,
    since,
    plansUrl: () => `${deps.server().replace(/\/+$/, "")}${GROUP_PRO_ONLY.upgradePath}`,
    ...(deps.githubStatus ? { githubStatus: deps.githubStatus } : {}),
  });
  plugin.register(() => status.dispose());

  let timer: number | undefined;
  let timerDueAt = Number.POSITIVE_INFINITY;
  let firstUserEventAt: number | null = null;
  const clearLookTimer = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    timerDueAt = Number.POSITIVE_INFINITY;
  };
  const fireLook = (): void => {
    timer = undefined;
    timerDueAt = Number.POSITIVE_INFINITY;
    const now = Date.now();
    const currentState = model.state();
    if (currentState.phase === "rate-limited" && (currentState.rateLimitedUntil ?? 0) > now) {
      firstUserEventAt = null;
      return;
    }
    const quietLeft = untitledCreateRemainingMs(plugin, now);
    if (quietLeft > 0) {
      const delay = quietLeft + UNTITLED_LOOK_PAD_MS;
      timerDueAt = now + delay;
      timer = window.setTimeout(fireLook, delay);
      return;
    }
    firstUserEventAt = null;
    void model.refresh();
  };
  const armLookTimer = (dueAt: number, now: number): void => {
    const delay = Math.max(0, dueAt - now);
    window.clearTimeout(timer);
    timerDueAt = now + delay;
    timer = window.setTimeout(fireLook, delay);
  };
  const lookSoon = (source: "user" | "own" | "poll" = "user"): void => {
    const now = Date.now();
    const currentState = model.state();
    if (currentState.phase === "rate-limited" && (currentState.rateLimitedUntil ?? 0) > now) return;
    if (source === "own") {
      if (timer !== undefined) return;
      armLookTimer(now + OWN_WRITE_LOOK_MS, now);
      return;
    }
    if (source === "poll") {
      const wanted = now + LOOK_DEBOUNCE_MS;
      if (timer !== undefined && timerDueAt <= wanted) return;
      armLookTimer(wanted, now);
      return;
    }
    if (firstUserEventAt === null) firstUserEventAt = now;
    const wanted = Math.min(now + LOOK_DEBOUNCE_MS, firstUserEventAt + MAX_LOOK_WAIT_MS);
    armLookTimer(wanted, now);
  };
  const watch = (file: { path: string }, oldPath?: string): void => {
    const listed =
      LISTED_FILE.test(file.path) ||
      file.path === ".gitignore" ||
      (typeof oldPath === "string" && (LISTED_FILE.test(oldPath) || oldPath === ".gitignore"));
    if (!listed) return;
    if (isOwnWrite(file.path) || (typeof oldPath === "string" && isOwnWrite(oldPath))) {
      lookSoon("own");
      return;
    }
    unquiet();
    lookSoon("user");
  };
  const scheduleWatch = deferDuringUntitled(plugin, () => {
    unquiet();
    lookSoon("user");
  });
  plugin.registerEvent(
    app.vault.on("create", (file) => {
      if (!LISTED_FILE.test(file.path) && file.path !== ".gitignore") return;
      if (isOwnWrite(file.path)) {
        lookSoon("own");
        return;
      }
      if (isFreshUntitled(plugin, file.path)) {
        scheduleWatch();
        return;
      }
      unquiet();
      lookSoon("user");
    }),
  );
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
    app.vault.on("rename", (file, oldPath) => {
      if (typeof oldPath === "string") {
        deps.ownLinks?.moved(oldPath, file.path);
      }
      watch(file, typeof oldPath === "string" ? oldPath : undefined);
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
  plugin.registerEvent(app.vault.on("modify", (file) => watch(file)));
  plugin.registerEvent(
    app.vault.on("delete", (file) => {
      deps.ownLinks?.forget(file.path);
      watch(file);
    }),
  );
  const signals = deps.signals ?? pageSignals(plugin, deps.live);
  const watcher = new Watch({ signals, moved: () => placed().mirror.moved(), live: () => deps.live?.() === true, look: () => lookSoon("poll"), stay: () => deps.stayOn?.() === true });
  const unquiet = (): void => watcher.unquiet();
  plugin.register(model.onLooked((looked) => watcher.looked(watchSignature(looked))));
  let lastResumedAt = Number.NEGATIVE_INFINITY;
  const resumed = (): void => {
    if (appHidden()) return;
    unquiet();
    lookSoon("user");
    const now = Date.now();
    if (now - lastResumedAt < RESUME_FLOOR_MS) return;
    lastResumedAt = now;
    void model.refreshPresence();
    const currentState = model.state();
    if (currentState.phase !== "rate-limited" || (currentState.rateLimitedUntil ?? 0) <= now) status.reviewsChanged();
  };
  watchWindows(plugin, (win, on) => {
    on(win.document, "visibilitychange", () => {
      if (appHidden()) current?.cache.flush();
      else resumed();
    });
    on(win, "focus", resumed);
    on(win, "beforeunload", () => current?.cache.flush());
    on(win, "pagehide", () => current?.cache.flush());
  });
  const first = window.setTimeout(() => plugin.registerInterval(window.setInterval(() => void watcher.tick(), CHECK_EVERY_MS)), clientPollOffset(CHECK_EVERY_MS));
  plugin.register(() => window.clearTimeout(first));
  plugin.register(() => clearLookTimer());
  plugin.register(() => current?.cache.flush());
  plugin.register(() => model.dispose());
  const reviewEvents = new ReviewEvents();
  const reaction = createPollGateFor(restingSignals(signals, () => deps.stayOn?.() === true)).reaction(({ expireReviews }) => {
    if (expireReviews) {
      model.expireReviews(reviewEvents.named(Date.now()));
      status.reviewsChanged();
    }
    unquiet();
    lookSoon("poll");
  });
  plugin.register(reaction.start());
  app.workspace.onLayoutReady(() => {
    unquiet();
    void model.refresh();
  });
  plugin.addCommand({
    id: "discard-all",
    name: DISCARD.command,
    checkCallback: (checking) => {
      if (model.state().busy) return false;
      if (!checking) void flows.discard(model.state().rows);
      return true;
    },
  });

  const sentBase = (path: string, doc: DocumentRef, since?: number, signal?: AbortSignal): Promise<string | null> | null =>
    sentBaseFor(
      {
        sentText,
        heldCommits,
        cacheEntry: (one, targetRepo) => {
          if (repo() !== targetRepo) return null;
          const entry = placed().cache.get(one);
          return entry?.sent ? { sha: entry.sent, to: (entry.sentTo as ReviewKey | undefined) ?? null, commit: entry.sentCommit, at: entry.sentAt } : null;
        },
        review,
        gitBlob: deps.gitBlob,
        publishedBranch: NOTE_BRANCH,
        forget: (one) => {
          if (repo() !== doc.repo) return;
          flows.forgetSent(one);
          model.learnSent(one, null);
        },
      },
      path,
      doc,
      since,
      signal,
    );

  return {
    model,
    flows,
    review,
    liveFiles,
    sentBase,
    attachments: () => placed().attachments,
    settingsChanged: () => {
      void model.refreshPresence(true);
      if (placeKey() === lookedAt) {
        model.redraw();
        return;
      }
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
    contents: (view) =>
      model.state().phase === "rate-limited" && model.vault() === null
        ? {}
        : { status: <StatusPanelTab controller={status} view={view ?? null} actions={actions} /> },
    badges: () => ({ comments: { open: 0 } }),
    rateLimit: () => {
      const state = model.state();
      return state.phase === "rate-limited" ? { retryAfterMs: state.retryAfterMs ?? null, until: state.rateLimitedUntil ?? null } : null;
    },
  };
}
