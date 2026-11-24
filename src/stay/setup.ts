import type { Plugin } from "obsidian";
import { gitBlobShaOfText } from "../changes/blob-sha";
import type { ChangesFlows } from "../changes/flows";
import type { ChangesModel } from "../changes/model";
import type { Connections } from "../connect/connections";
import type { BaseStore, LocalState } from "../disk/bases";
import { withEol } from "../disk/line-endings";
import { guardedBinaryCreate, guardedVault, watchCanvasEditing } from "../disk/guarded-vault";
import { guardedBinaryCreateStream, hashVaultBinary, replaceAttachmentStream } from "../disk/vault-binary";
import type { BlobsAnswer, BranchFile, AttachmentFile, MainFile, RenamedTarget } from "../auth/git-copy";
import type { ReviewKey } from "../changes/review-key";
import { showChanges } from "../review/modals";
import { type DocumentRef, fileFor, isHiddenPath, normalizeFolder, underFolder } from "../mapping";
import { bringInDraft, bringInNewer, type BroughtDraft, type BroughtNewer } from "../changes/bring-in";
import { copiedWords, copyIn, FILES_PER_BATCH, type CopyInFile, type CopyInOptions, type CopyInPorts, type CopyInResult } from "../changes/copy-in";

import { endOf, readReviewEnds } from "./ends";
import { fileAttachmentLinks } from "../changes/attachment-links";
import { attachmentPlacement, type BringPorts, AttachmentLooks, draftElseMain } from "../changes/bring-attachments";
import { isAttachmentPath } from "../shared/review-flow";
import type { AttachmentMemory } from "../changes/attachment-memory";
import { gitBlobSha } from "../changes/blob-sha";
import { replaceAttachment } from "./replace-attachment";
import { isLeftOutKind, leftOutKinds } from "../changes/left-out";
import { copyingWords } from "../pick/words";
import { showNotice, showNoticeWithAction, showProgress } from "../notices";
import { type ReviewApi, reviewIsOpen } from "../review/review-api";
import { ENDING_WRITES_PER_HOUR } from "../shared/review-flow";
import type { Settings } from "../settings";
import type { StatusBoard } from "../status";
import type { ChangeRow, Looked } from "../changes/model";
import type { Dialogs } from "../changes/flow-deps";
import type { ReviewRequest } from "../editor/services";
import { recordMainBase } from "../changes/main-base";
import { Activity } from "./activity";
import { locateGit } from "./git-desktop";
import { tiedTo } from "./tie";
import { NOTE_BRANCH } from "../auth/config";
import { GitWatch } from "./git-watch";
import { StayConnected } from "./engine";
import type { Draft, StayDrafts } from "./draft-state";
import { WriteBudget } from "./limits";
import { StayState } from "./state";
import type { AutoCommitOutcome, DraftBase, StayPorts } from "./types";
import { OFFER } from "./words";
import { appHidden, watchWindows } from "../windows";

export interface StayDeps {
  settings: () => Settings;
  setStayConnected: (on: boolean) => Promise<void>;
  model: ChangesModel;
  flows: ChangesFlows;
  review: Pick<ReviewApi, "status"> & Partial<Pick<ReviewApi, "details" | "mergePreview">>;
  status: StatusBoard;
  connections: Connections;
  bases: BaseStore;
  gitFile: (doc: DocumentRef, at?: string) => Promise<MainFile>;
  wasDeleted: (doc: DocumentRef) => Promise<{ deletedAt: number } | null | "unknown">;
  renamedTo?: (doc: DocumentRef) => Promise<RenamedTarget | null | "unknown">;
  gitBlobs?: (repo: string, commit: string, files: ReadonlyArray<{ sha: string; path: string }>) => Promise<BlobsAnswer>;
  gitExist?: (repo: string, paths: ReadonlyArray<string>) => Promise<{ kind: "answered"; files: Map<string, boolean> } | { kind: "missing" } | { kind: "outage" }>;
  gitBlobsByOid?: (repo: string, files: ReadonlyArray<{ sha: string; path: string }>) => Promise<BlobsAnswer>;
  gitAttachment?: (repo: string, at: string, path: string, options?: { ifNoneMatch?: string }) => Promise<AttachmentFile>;
  gitFindAttachment?: (repo: string, branch: string, notePath: string, embed: string) => Promise<AttachmentFile>;
  listing?: (repo: string) => Promise<{ commit: string | null; files: ReadonlyMap<string, string> } | null>;
  gitBlob: (doc: DocumentRef, sha: string) => Promise<string | null>;
  attachmentMemory?: () => AttachmentMemory;
  openStatus?: () => void;
  vaultPath: (path: string) => string;
  branchFile: (doc: DocumentRef, branch: string) => Promise<BranchFile>;
  signedIn: () => boolean;
  login: () => string;
  chooseWhatToKeep: (request: ReviewRequest) => Promise<string | null>;
  dialogs: Dialogs;
}

export interface StayHandle {
  settingsChanged(): void;
  flush(): void;
  offer(): Promise<void>;
  groupHeld(): Promise<void>;
  isKept(path: string): boolean;
  stopped(path: string): void;
  deletedOnGithub(path: string, at: number): void;
  deletedAt(path: string): number | null;
  restored(path: string): void;
  heldWhy(path: string): string | null;
  attachmentProblems(path: string, problems: ReadonlyArray<{ name: string; why: string }>): void;
  touched(path: string): void;
  heardDraft(repoPath: string, sha?: string): void;
  addToMyNote(path: string): void;
  offered(): readonly string[];
  policyFor(path: string, draft: Pick<Draft, "blob">): StayDrafts;
  addOffered(): void;
  heardReview(branch: string): void;
  bringFor(path: string, text: string): Promise<void>;
  bringInNewer(): Promise<BroughtNewer>;
  bringInDraft(path: string): Promise<BroughtDraft>;
  copyIn(files: readonly CopyInFile[], skipped?: readonly string[]): Promise<CopyInResult>;
}

async function readDraftBase(
  mergePreview: NonNullable<StayDeps["review"]["mergePreview"]>,
  doc: DocumentRef,
  branch: string,
): Promise<DraftBase | null> {
  const seen = await mergePreview(doc, branch, NOTE_BRANCH);
  if (!seen.ok) return null;
  const body = seen.body as { baseSource?: unknown; theirsSource?: unknown } | null;
  if (typeof body?.baseSource !== "string" || body.baseSource === "" || typeof body?.theirsSource !== "string") return null;
  return { base: body.baseSource, main: body.theirsSource };
}

export const PLACE_SETTLES_MS = 1_000;

export function setUpStay(plugin: Plugin, deps: StayDeps): StayHandle {
  const { app } = plugin;
  const localState: LocalState = { load: (name) => app.loadLocalStorage(name) as unknown, save: (name, value) => app.saveLocalStorage(name, value) };
  const activity = new Activity();
  const vault = guardedVault(app);
  const place = (): string => `${deps.settings().repo}\n${normalizeFolder(deps.settings().folder)}`;
  const identity = (): string => `${place()}\n${deps.login()}`;
  const mapped = (path: string): DocumentRef | null => fileFor(deps.settings(), path);
  let lookTimer: number | undefined;
  const lookAgain = (): void => {
    window.clearTimeout(lookTimer);
    lookTimer = window.setTimeout(() => void deps.model.refresh(), 400);
  };
  let unloaded = false;
  plugin.register(() => {
    unloaded = true;
    window.clearTimeout(lookTimer);
  });

  const planFor = async (files: readonly CopyInFile[]): Promise<{ files: CopyInFile[]; options: CopyInOptions }> => {
    const states = deps.model.vault();
    if (files.length > 0 && files.every((file) => file.doc.repo === deps.settings().repo) && states !== null) {
      return { files: files.map((file) => ({ ...file, sha: file.sha ?? states.files.get(file.path)?.repoSha ?? null })), options: deps.model.copyOptions() };
    }
    const first = files[0];
    const listed = first ? await deps.listing?.(first.doc.repo).catch(() => null) : null;
    if (!first || !listed) return { files: [...files], options: {} };
    const prefix = first.path.slice(0, first.path.length - first.doc.path.length);
    const vaultPaths = new Set(app.vault.getFiles().map((file) => file.path.toLowerCase()));
    const others = [...listed.files.keys()].filter((path) => isLeftOutKind(path) && !vaultPaths.has(`${prefix}${path}`.toLowerCase())).map((path) => `${prefix}${path}`);
    return {
      files: files.map((file) => ({ ...file, sha: file.sha ?? listed.files.get(file.doc.path) ?? null })),
      options: { commit: listed.commit, others, attachments: new Map(others.filter((path) => isAttachmentPath(path)).map((path) => [path, path.slice(prefix.length)])) },
    };
  };

  interface CopyJob {
    key: string;
    active: boolean;
    wanted: Array<() => boolean>;
    result: Promise<CopyInResult>;
  }
  let job: CopyJob | null = null;
  const nothing = (): CopyInResult => ({ created: 0, attachments: 0, existed: 0, gone: 0, left: 0, unreadable: [], skipped: [], leftOut: leftOutKinds([]), stopped: null });
  const copyNotesIn = async (files: readonly CopyInFile[], isCurrent: () => boolean = () => true, skipped: readonly string[] = []): Promise<CopyInResult> => {
    if (files.length === 0 && skipped.length === 0) return nothing();
    const repo = files[0]?.doc.repo ?? "";
    const prefix = files[0] ? files[0].path.slice(0, files[0].path.length - files[0].doc.path.length) : "";
    const key = `${repo}\0${prefix}\0${identity()}`;
    const top = normalizeFolder(deps.settings().folder);
    while (job !== null) {
      if (job.active && job.key === key && job.wanted.some((wanted) => wanted())) {
        job.wanted.push(isCurrent);
        return job.result;
      }
      await job.result.catch(() => undefined);
    }
    if (!isCurrent()) return { ...nothing(), left: files.length, stopped: "unloaded" };
    const mine: CopyJob = { key, active: true, wanted: [isCurrent], result: Promise.resolve(nothing()) };
    mine.result = (async (): Promise<CopyInResult> => {
      let copiedNow = 0;
      deps.model.copying({ done: 0, total: files.length });
      const shown = showProgress(copyingWords(0, files.length));
      try {
        const plan = await planFor(files);
        const copying: CopyInPorts = {
          gitFile: (doc, at) => deps.gitFile(doc, at ?? undefined),
          ...(deps.gitBlobs ? { gitBlobs: deps.gitBlobs } : {}),
          ...(deps.gitAttachment ? { gitAttachment: (from, at, path) => deps.gitAttachment!(from, at ?? NOTE_BRANCH, path) } : {}),
          create: (path, text) => vault.create(path, text),
          createBinary: guardedBinaryCreate(app),
          createBinaryStream: guardedBinaryCreateStream(app),
          agreed: (repoPath, sha) => deps.attachmentMemory?.().agree(repoPath, sha),
          recordBase: (file, _text, sha) => deps.model.copiedFrom(file.path, sha),
          checkpoint: () => deps.model.checkpoint(),
          vaultPaths: () => app.vault.getFiles().map((file) => file.path),
          notWritten: (path) => activity.notWritten(path),
          during: (paths, run, left) => activity.during(paths, run, left),
          blockedFor: () => WriteBudget.open(localState, deps.login()).waitFor(0),
          pause: (ms) => new Promise((resume) => window.setTimeout(resume, ms)),
          clock: () => performance.now(),
          current: () => mine.wanted.some((wanted) => wanted()),
          progress: (done, total) => {
            shown.set(copyingWords(done, total));
            deps.model.copying({ done, total });
          },
        };
        const result = await copyIn(copying, plan.files, skipped, { ...plan.options, top });
        showNotice(copiedWords(result));
        copiedNow = result.created;
        return result;
      } finally {
        mine.active = false;
        shown.hide();
        try {
          await deps.model.refresh();
          if (copiedNow > 0) await deps.model.checkNow();
        } catch {
          void 0;
        } finally {
          job = null;
          deps.model.copying(null);
        }
      }
    })();
    job = mine;
    return mine.result;
  };

  const blobTexts = async (asked: ReadonlyArray<{ doc: DocumentRef; sha: string }>): Promise<Map<string, string>> => {
    const found = new Map<string, string>();
    const commit = deps.model.copyOptions().commit;
    if (!deps.gitBlobs || commit === null || commit === undefined) return found;
    for (let at = 0; at < asked.length; at += FILES_PER_BATCH) {
      const run = asked.slice(at, at + FILES_PER_BATCH);
      const answer = await deps.gitBlobs(run[0]!.doc.repo, commit, run.map(({ doc, sha }) => ({ sha, path: doc.path })));
      if (answer.kind !== "answered") break;
      for (const { sha } of run) {
        const read = answer.files.get(sha);
        if (read?.kind === "text") found.set(sha, read.text);
      }
    }
    return found;
  };

  const draftTexts = async (asked: ReadonlyArray<{ doc: DocumentRef; sha: string }>): Promise<Map<string, string>> => {
    const found = new Map<string, string>();
    if (!deps.gitBlobsByOid) return found;
    for (let at = 0; at < asked.length; at += FILES_PER_BATCH) {
      const run = asked.slice(at, at + FILES_PER_BATCH);
      const answer = await deps.gitBlobsByOid(run[0]!.doc.repo, run.map(({ doc, sha }) => ({ sha, path: doc.path })));
      if (answer.kind !== "answered") break;
      for (const { sha } of run) {
        const read = answer.files.get(sha);
        if (read?.kind === "text") found.set(sha, read.text);
      }
    }
    return found;
  };

  const confirmGone = async (docs: ReadonlyArray<DocumentRef>): Promise<Map<string, boolean> | null> => {
    if (!deps.gitExist) return null;
    const found = new Map<string, boolean>();
    for (let at = 0; at < docs.length; at += FILES_PER_BATCH) {
      const run = docs.slice(at, at + FILES_PER_BATCH);
      const answer = await deps.gitExist(run[0]!.repo, run.map((one) => one.path));
      if (answer.kind === "missing") return null;
      if (answer.kind === "outage") break;
      for (const [path, exists] of answer.files) found.set(path, exists);
    }
    return found;
  };

  const attachmentLooks = new AttachmentLooks();
  const bringAttachments = async (doc: DocumentRef, branch: string, notePath: string, text: string, said: (words: string | null) => void, options: { replace?: boolean } = {}): Promise<void> => {
    if (!deps.gitAttachment || !deps.gitFindAttachment) return;
    const memory = deps.attachmentMemory?.();
    const folder = normalizeFolder(deps.settings().folder);
    const configDir = (app.vault as { configDir?: string }).configDir;
    const ports: BringPorts = {
      ...(configDir !== undefined ? { configDir } : {}),
      now: () => Date.now(),
      resolve: (link, from) => {
        const file = app.metadataCache.getFirstLinkpathDest(link, from);
        return file ? { path: file.path, mtime: file.stat.mtime, size: file.stat.size } : null;
      },
      repoPathOf: (vaultPath) => underFolder(folder, vaultPath),
      vaultPathOf: (repoPath) => attachmentPlacement(folder, repoPath, configDir),
      findAttachment: (link) => deps.gitFindAttachment!(doc.repo, branch, doc.path, link),
      told: (path, words) => deps.model.attachmentTold(path, words, "bring"),
      draftAttachment:
        branch === NOTE_BRANCH
          ? (repoPath, ifNoneMatch) => deps.gitAttachment!(doc.repo, NOTE_BRANCH, repoPath, ifNoneMatch ? { ifNoneMatch } : undefined)
          : draftElseMain(
              (repoPath, ifNoneMatch) => deps.gitAttachment!(doc.repo, branch, repoPath, ifNoneMatch ? { ifNoneMatch } : undefined),
              (repoPath, ifNoneMatch) => deps.gitAttachment!(doc.repo, NOTE_BRANCH, repoPath, ifNoneMatch ? { ifNoneMatch } : undefined),
            ),
      vaultSha: (file) => {
        const target = app.vault.getFileByPath(file.path);
        return memory && target ? memory.hash(file.path, file, () => hashVaultBinary(app, file.path, file.size)) : Promise.resolve("");
      },
      shaOf: (bytes) => gitBlobSha(bytes),
      notWritten: (path) => activity.notWritten(path),
      during: (paths, run, left) => activity.during(paths, run, left),
      replace: (path, bytes, expectedSha) => replaceAttachment(app.vault, path, bytes, expectedSha),
      replaceStream: replaceAttachmentStream(app),
      create: async (path, bytes) => {
        const made = await guardedBinaryCreate(app)(path, bytes);
        return made;
      },
      createStream: guardedBinaryCreateStream(app),
    };
    await attachmentLooks.bring(ports, memory, branch, notePath, text, said, options);
  };
  const bringFor = async (path: string, text: string): Promise<void> => {
    const doc = mapped(path);
    if (!doc || !deps.gitAttachment || !deps.gitFindAttachment) return;
    if (fileAttachmentLinks(path, text).every((link) => app.metadataCache.getFirstLinkpathDest(link, path) !== null)) return;
    try {
      const status = await deps.review.status(doc);
      await bringAttachments(doc, status?.reviewBranch ?? NOTE_BRANCH, path, text, (words) => engine?.attachmentRow(path, words));
    } catch {
      void 0;
    }
  };

  const git = new GitWatch(() => locateGit(app), activity);

  const ports: StayPorts = {
    copyIn: copyNotesIn,
    now: () => Date.now(),
    enabled: () => deps.settings().stayConnected,
    signedIn: deps.signedIn,
    documentFor: mapped,
    phaseOf: (path) => deps.status.phaseOf(path),
    disconnected: (doc) => deps.connections.isDisconnected(doc),
    gitFile: deps.gitFile,
    wasDeleted: deps.wasDeleted,
    ...(deps.renamedTo ? { renamedTo: deps.renamedTo } : {}),
    git: { checkSince: (saved) => git.checkSince(saved), poll: () => git.poll() },
    ...(deps.gitBlobs ? { blobTexts: blobTexts } : {}),
    ...(deps.gitBlobsByOid ? { draftTexts } : {}),
    ...(deps.gitExist ? { confirmGone } : {}),
    ...(deps.gitAttachment && deps.gitFindAttachment ? { bringAttachments, bringFor } : {}),
    attachmentRow: (path, words) => engine?.attachmentRow(path, words),
    reviewOf: async (doc) => {
      const read = await deps.review.status(doc);
      if (read === null) return "unknown";
      return reviewIsOpen(read) ? "open" : "none";
    },
    vault,
    blobText: deps.gitBlob,
    baseText: (path, sha) => {
      const read = deps.bases.read(path);
      if (sha === null || read.status !== "found") return null;
      return gitBlobShaOfText(withEol(read.base.text, read.base.eol)) === sha ? read.base.text : null;
    },
    recordBase: (path, doc, _text, raw) => recordMainBase(deps.bases, path, doc, raw),
    rebase: (path, sha) => deps.model.rebased(path, sha),
    chooseWhatToKeep: deps.chooseWhatToKeep,
    commit: async (row: ChangeRow, isCurrent, hooks): Promise<AutoCommitOutcome> => {
      const done = await deps.flows.autoCommit(row, isCurrent, hooks);
      if (done.result === "committed" && done.inVault !== false && (row.change.kind === "new" || row.change.kind === "renamed")) deps.connections.defaultsChanged();
      return done;
    },
    localSentBase: (path, doc, draft) => deps.flows.localSentBase?.(path, doc, draft) ?? Promise.resolve(null),
    retryAttachments: (row, isCurrent, hooks) => deps.flows.autoAttachments(row, isCurrent, hooks),
    hidden: appHidden,
    offline: () => deps.model.offline(),
    login: deps.login,
    policy: () => deps.settings().stayDrafts,
    draftFile: deps.branchFile,
    ...(deps.review.mergePreview
      ? {
          draftBase: (doc, branch) => readDraftBase((...args) => deps.review.mergePreview!(...args), doc, branch),
        }
      : {}),
    reviewEnd: async (doc, group = false) => {
      const read = await deps.review.status(doc);
      if (read === null) return "unknown";
      if (reviewIsOpen(read)) return "open";
      if (read.pr?.state === "closed") {
        const got = await deps.review.details?.(doc.repo, [read.pr.number]);
        const detail = got instanceof Map ? got.get(read.pr.number) : undefined;
        return endOf(detail ?? read.pr, deps.login(), group || read.pr.group !== undefined);
      }
      return endOf(read.pr, deps.login(), group);
    },
    reviewEnds: (files) => readReviewEnds(files, deps.review.details ? (repo, numbers) => deps.review.details!(repo, numbers) : undefined, deps.login, FILES_PER_BATCH),
    agreed: (path, agreement) => {
      deps.flows.forgetSent(path);
      if (agreement === null) deps.model.learnSent(path, null);
      else deps.model.learnSent(path, agreement.sent, agreement.to as ReviewKey | null, { ...(agreement.agreed === undefined ? {} : { agreed: agreement.agreed }), ...(agreement.commit === undefined ? {} : { commit: agreement.commit }) });
    },
    agreedAs: (path, agreed) => deps.model.learnAgreed(path, agreed),
    notify: (message, action, options) => (action ? showNoticeWithAction(message, action.label, action.run, options?.lasting === true) : showNotice(message, options?.lasting === true)),
    holdsChanged: () => deps.model.redraw(),
    aware: () => deps.model.state().aware !== null,
    awareLine: (about) => void deps.model.checkNow(about),
    heldDeletes: (offer) => deps.model.holdDeletes(offer),
    choice: (path, choice) => deps.model.offerChoice(path, choice),
    lookAgain,
    seeChanges: (shown) => showChanges(app, shown, { kind: "from-github" }),
    openStatus: () => void deps.openStatus?.(),
    settleReview: (path) => {
      const row = deps.model.row(path);
      if (row) void deps.flows.settleFromMain(row);
    },
    personBusy: () => deps.model.state().busy,
    forgetDelete: (path) => deps.model.settledDelete(path),
    groupsOn: () => deps.model.state().groupsOn,
    groupsLocked: () => deps.model.state().groupsLocked,
    inGroup: (path) => deps.model.groupOf(path) !== undefined,
    createGroup: async (rows) => {
      const made = await deps.flows.createGroup(rows);
      return {
        outcome: made.ok ? "made" : made.limited === true ? "limited" : "failed",
        writes: made.writes ?? 0,
        ...(!made.ok && made.retryAfterMs !== undefined ? { retryAfterMs: made.retryAfterMs } : {}),
      };
    },
    diagnose: (what) => console.debug(`specgit: stay connected: ${what}`),
    later: (fn, ms) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
  };

  let engine: StayConnected | null = null;
  let engineIdentity = "";
  let lastLooked: Looked | null = null;
  const oneShots = new Set<StayConnected>();
  let draftOnce: { engine: StayConnected; pending: number } | null = null;
  const flushAll = (): void => {
    engine?.flush();
    for (const one of oneShots) one.flush();
  };
  const stopOneShots = (): void => {
    draftOnce = null;
    for (const one of oneShots) one.stop();
    oneShots.clear();
  };
  const stop = deps.model.onLooked((looked) => {
    lastLooked = looked;
    if (engine && engineIdentity !== identity()) settingsChanged();
    engine?.lookedAt(looked);
  });
  plugin.register(stop);
  plugin.register(() => {
    engine?.stop();
    stopOneShots();
  });
  let notLocal = new Set<string>();
  plugin.register(
    deps.status.subscribe(() => {
      engine?.livened();
      const now = new Set(deps.status.paths().filter((path) => deps.status.phaseOf(path) !== "local"));
      const freed = [...notLocal].filter((path) => !now.has(path));
      notLocal = now;
      engine?.freed(freed);
    }),
  );

  const fresh = (always = false): StayConnected => {
    const allowed: StayPorts = always ? { ...ports, enabled: () => true } : ports;
    const at = identity();
    if (!always) engineIdentity = at;
    const settings = { repo: deps.settings().repo, folder: deps.settings().folder };
    const tied = tiedTo(allowed, at, identity, (path) => fileFor(settings, path), activity);
    const state = new StayState(place(), localState);
    const serverTakes = (): number => (deps.model.state().groups.some((row) => row.group?.overview.ending !== undefined && row.group.overview.ending.stopped === undefined) ? ENDING_WRITES_PER_HOUR : 0);
    return new StayConnected(tied, state, activity, WriteBudget.open(localState, deps.login(), Date.now, serverTakes));
  };

  const touched = (path: string): void => activity.touched(path);
  const isTrackedPath = (path: string): boolean => !isHiddenPath(path) && mapped(path) !== null;
  const isTrackedFile = (file: { path: string; children?: unknown }): boolean => !("children" in file) && isTrackedPath(file.path);
  app.workspace.onLayoutReady(() => {
    plugin.registerEvent(app.vault.on("create", (file) => (isTrackedFile(file) ? touched(file.path) : undefined)));
    plugin.registerEvent(app.vault.on("modify", (file) => (isTrackedFile(file) ? touched(file.path) : undefined)));
    plugin.registerEvent(app.vault.on("delete", (file) => (isTrackedFile(file) ? touched(file.path) : undefined)));
    plugin.registerEvent(
      app.vault.on("rename", (file, from) => {
        if ("children" in file) return;
        if (isTrackedPath(file.path)) activity.renamed(from, file.path);
        else if (isTrackedPath(from)) touched(from);
      }),
    );
    plugin.registerEvent(app.workspace.on("active-leaf-change", () => engine?.panesChanged()));
    plugin.registerEvent(app.workspace.on("layout-change", () => engine?.panesChanged()));
  });

  let wasHidden = false;
  watchWindows(plugin, (win, on) => {
    on(win.document, "visibilitychange", () => {
      if (appHidden()) {
        wasHidden = true;
        flushAll();
      } else if (wasHidden) {
        wasHidden = false;
        engine?.returned();
      }
    });
    on(win, "beforeunload", () => flushAll());
    on(win, "pagehide", () => flushAll());
    watchCanvasEditing(win, on, () => engine?.panesChanged());
  });

  plugin.registerInterval(window.setInterval(() => void engine?.pollGit(), 1_000));

  let moving = false;
  const sync = (): void => {
    moving = false;
    const wanted = deps.settings().stayConnected;
    if (engine && engineIdentity !== identity()) {
      engine.stop();
      engine = null;
    }
    if (wanted && !engine) {
      stopOneShots();
      engine = fresh();
    }
    if (wanted) engine?.enable();
    else if (engine) {
      engine.stop();
      engine = null;
    }
    deps.connections.defaultsChanged();
  };
  sync();

  plugin.addCommand({
    id: "group-held",
    name: "Group the files that arrived at once",
    checkCallback: (checking) => {
      if (engine?.canGroupHeld() !== true) return false;
      if (!checking) void engine.groupHeld();
      return true;
    },
  });

  let lastWanted = deps.settings().stayConnected;
  let lastDrafts = deps.settings().stayDrafts;
  let settling: number | undefined;
  plugin.register(() => window.clearTimeout(settling));
  const settingsChanged = (): void => {
    window.clearTimeout(settling);
    const wanted = deps.settings().stayConnected;
    const drafts = deps.settings().stayDrafts;
    const flipped = wanted !== lastWanted;
    const draftsChanged = drafts !== lastDrafts;
    lastWanted = wanted;
    lastDrafts = drafts;
    if (engine !== null && engineIdentity !== identity()) {
      moving = true;
      if (wanted) engine.stop();
      else engine.disable();
      engine = null;
    }
    if (!flipped && (wanted === (engine !== null) || (moving && wanted))) {
      if (draftsChanged && wanted) deps.connections.defaultsChanged();
      if (!draftsChanged || moving) settling = window.setTimeout(sync, PLACE_SETTLES_MS);
    } else sync();
  };

  return {
    settingsChanged,
    flush: flushAll,
    groupHeld: async () => void (await engine?.groupHeld()),
    isKept: (path) => engine?.isKept(path) === true,
    stopped: (path) => void engine?.holdStopped(path),
    deletedOnGithub: (path, at) => engine?.deletedOnGithub(path, at),
    deletedAt: (path) => engine?.deletedAt(path) ?? null,
    restored: (path) => engine?.restored(path),
    heldWhy: (path) => engine?.heldWhy(path) ?? null,
    attachmentProblems: (path, problems) => engine?.attachmentProblems(path, problems),
    heardDraft: (repoPath, sha) => engine?.heardDraft(deps.vaultPath(repoPath), undefined, undefined, sha),
    offered: () => engine?.offered() ?? [],
    policyFor: (path, draft) => engine?.policyFor(path, draft) ?? deps.settings().stayDrafts,
    addOffered: () => engine?.addOffered(),
    addToMyNote: (path) => {
      if (engine) return engine.addToMyNote(path);
      if (!draftOnce || !oneShots.has(draftOnce.engine)) {
        const once = fresh(true);
        once.lookedAt(lastLooked);
        oneShots.add(once);
        draftOnce = { engine: once, pending: 0 };
      }
      const slot = draftOnce;
      slot.pending++;
      void slot.engine.addToMyNoteOnce(path).finally(() => {
        slot.pending--;
        if (slot.pending === 0) {
          if (draftOnce === slot) draftOnce = null;
          if (oneShots.delete(slot.engine)) slot.engine.stop();
        }
      });
    },
    heardReview: (branch) => engine?.heardReview(branch),
    bringInNewer: async () => {
      const box: { current: StayConnected | null } = { current: null };
      try {
        return await bringInNewer({
          files: () => deps.model.vault()?.files ?? null,
          read: (path) => vault.read(path),
          bringIn: async (path) => {
            if (engine) return engine.bringIn(path);
            if (!box.current || !oneShots.has(box.current)) {
              const once = fresh(true);
              once.lookedAt(lastLooked);
              oneShots.add(once);
              box.current = once;
            }
            return box.current.bringIn(path);
          },
        });
      } finally {
        if (box.current && oneShots.delete(box.current)) box.current.stop();
      }
    },
    bringInDraft: (path) =>
      bringInDraft(
        {
          draftOf: (one) => {
            const draft = deps.model.draftFor(one);
            const doc = mapped(one);
            return draft && doc ? { doc, branch: draft.branch, blob: draft.blob } : null;
          },
          ...(deps.gitBlobsByOid ? { gitBlobsByOid: deps.gitBlobsByOid } : {}),
          branchFile: deps.branchFile,
          vaultPaths: () => app.vault.getFiles().map((file) => file.path),
          create: (target, text) => activity.during([target], () => vault.create(target, text), (result) => (result === "created" ? { [target]: gitBlobShaOfText(text) } : null)),
          bringFor,
        },
        path,
      ),
    bringFor,
    touched,
    copyIn: (files, skipped) => {
      const at = identity();
      let alive = true;
      return copyNotesIn(files, () => (alive &&= !unloaded && deps.signedIn() && identity() === at), skipped);
    },
    offer: async () => {
      const settings = deps.settings();
      if (settings.stayOffered || settings.stayConnected) return;
      settings.stayOffered = true;
      const yes = await deps.dialogs.confirm({ title: OFFER.title, description: OFFER.description(settings.repo), confirmLabel: OFFER.confirm, cancelLabel: OFFER.cancel });
      await deps.setStayConnected(yes);
    },
  };
}
