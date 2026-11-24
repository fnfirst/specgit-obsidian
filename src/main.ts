import { Platform, Plugin, setIcon, setTooltip } from "obsidian";
import { MARK_ICON } from "./brand/mark";
import { registerMark } from "./brand/register";
import { SpecgitAccount } from "./account";
import { addAuthCommands, obsidianTransport, setUpAuth, type SpecgitAuth } from "./auth";
import { NOTE_BRANCH } from "./auth/config";
import { Board } from "./board";
import { SpecgitApi } from "./api";
import { obsidianDialogs } from "./changes/dialogs";
import { listRepository } from "./changes/mirror-listing";
import { OwnLinks } from "./changes/own-links";
import { setUpChanges } from "./changes/setup";
import { pageSignals, setUpComments } from "./comments/setup";
import { setUpEvents } from "./events/setup";
import { setUpStay, type StayHandle } from "./stay/setup";
import { follows } from "./stay/draft-state";
import { Connections } from "./connect/connections";
import { ensureOpen, setUpConnect } from "./connect/setup";
import { setUpNoteBar } from "./changes/note-bar-setup";
import { cameInWords, changesIn, type Shown } from "./disk/regions";
import { GitBases } from "./disk/git-bases";
import { diskPath } from "./disk/vault";
import { noteUrl, openExternalUrl } from "./links";
import { ReadingBars } from "./cursors/reading";
import { liveEditor } from "./editor/extension";
import { docKey, documentFor, type DocumentRef, fileFor, isRepoName, normalizeFolder, placeOf } from "./mapping";
import { setUpOnboard } from "./onboard/setup";
import { setUpPick } from "./pick/setup";
import { ConnectionLifecycle } from "./network/lifecycle";
import { SocketPool } from "./network/sockets";
import { appHidden, watchWindows } from "./windows";
import { setAwareNotices, showNotice, showNoticeWithAction, showNoticeWithActions } from "./notices";
import { chooseWhatToKeep, showChanges } from "./review/modals";
import { closeMenus } from "./brand/menu";
import { closeDialogs } from "./brand/modal";
import { openOnFirstRun } from "./panel/first-run";
import type { PanelHandle } from "./panel/setup";
import { setUpReport } from "./report/setup";
import { OwnRestarts } from "./room/own-restarts";
import { RoomPool } from "./room/pool";
import { hocuspocusTransport } from "./room/transport";
import { DEFAULT_SETTINGS, DeviceSettings, identityFrom, readSettings, sameStayPlace, type Settings, type SettingsHost, SpecgitSettingTab, type StayPlace, stayPlaceOf, withoutDeviceSettings } from "./settings";
import { Signal } from "./signal";
import { StatusBoard, statusText, statusTip, wordFor } from "./status";
import { customServerQuestion, STAY_PAUSED_NOTICE } from "./stay/words";

const DISCONNECTED_KEY = "specgit-disconnected";

export default class SpecgitPlugin extends Plugin implements SettingsHost {
  config: Settings = DEFAULT_SETTINGS;
  private stay: StayHandle | null = null;
  private account: SpecgitAccount | null = null;
  private connections: Connections | null = null;
  private device = new DeviceSettings({ load: () => null, save: () => undefined });
  private readonly settingsSaved = new Signal();

  override async onload(): Promise<void> {
    this.device = new DeviceSettings({ load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) });
    this.config = { ...readSettings(await this.loadData()), ...this.device.read() };
    let stayPaused = false;
    if (this.config.stayConnected) {
      const current = stayPlaceOf(this.config);
      const placed = this.device.readStayPlace();
      if (placed === null) {
        if (isRepoName(this.config.repo)) this.device.writeStayPlace(current);
      } else if (!sameStayPlace(placed, current)) {
        this.config.stayConnected = false;
        this.device.write(this.config);
        stayPaused = true;
      }
    }
    registerMark();
    if (stayPaused) showNotice(STAY_PAUSED_NOTICE, true);

    const ownRestarts = new OwnRestarts(undefined, { load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) });
    const ownLinks = new OwnLinks();
    let askCustomServer: ((host: string) => Promise<boolean>) | null = null;
    const { auth, tokens, gitCopy, roomPeople, binary, signIn } = setUpAuth(this, {
      server: this.config.server,
      pendingSteps: (doc) => ownRestarts.asking(docKey(doc)),
      confirmServer: async (host) => {
        if (this.device.isTrustedServer(host)) return true;
        if (!askCustomServer) return false;
        const ok = await askCustomServer(host);
        if (ok) this.device.trustServer(host);
        return ok;
      },
    });
    addAuthCommands(this, { auth, signIn });
    if (!auth.isSignedIn() && (this.config.login !== "" || this.config.displayName !== "" || this.config.avatarUrl !== "")) {
      this.config.login = "";
      this.config.displayName = "";
      this.config.avatarUrl = "";
      this.device.write(this.config);
    }
    const account = new SpecgitAccount(auth, signIn, this);
    this.account = account;

    const sockets = new SocketPool();
    const rooms = new RoomPool(
      hocuspocusTransport(sockets, tokens),
      () => identityFrom(this.config),
      (note) => tokens.leave(note),
      tokens,
    );
    const board = new StatusBoard();
    const cameIn = new Board<Shown[]>();
    const deferredNew = new Map<string, string>();
    let isDeferredLocalNew = (_doc: DocumentRef): boolean => false;
    let isDeferredTeammateDraft = (_doc: DocumentRef): boolean => false;
    const connections = new Connections(
      (doc) => this.config.stayConnected && !isDeferredLocalNew(doc) && !isDeferredTeammateDraft(doc),
      {
        load: () => {
          const stored = this.app.loadLocalStorage(DISCONNECTED_KEY) as unknown;
          return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
        },
        save: (keys) => this.app.saveLocalStorage(DISCONNECTED_KEY, keys),
      },
    );
    this.connections = connections;
    const disk = diskPath(this.app);
    const gitBases = new GitBases({
      bases: disk.bases,
      vault: disk.vault,
      documentFor: (path) => documentFor(this.config, path),
      gitCopy: (doc) => gitCopy.read(doc),
      signedIn: () => auth.isSignedIn(),
      repoSha: (path) => repoShaOf(path),
    });
    this.register(gitBases.watch());
    this.register(() => {
      rooms.destroy();
      sockets.destroy();
    });

    let repoShaOf = (_path: string): string | null => null;
    let isLocalOnlyNew = (_path: string): boolean => false;
    let mainMoved = (_path: string): boolean => false;
    let draftBy = (_path: string): Promise<string | null> => Promise.resolve(null);
    let liveJoined = (_path: string): void => undefined;
    let sentBase = (_path: string, _doc: DocumentRef, _since?: number, _signal?: AbortSignal): Promise<string | null> | null => null;
    let deletedOnMain = (_path: string): boolean => false;
    let checkConnected = (): Promise<void> => Promise.resolve();
    let unsent = (): Promise<number | null> => Promise.resolve(null);
    const reading = new ReadingBars();
    this.registerMarkdownPostProcessor((el, ctx) => reading.process(el, ctx));
    this.register(() => reading.destroy());
    this.registerEditorExtension(
      liveEditor({
        reading,
        isLocalOnlyNew: (path) => isLocalOnlyNew(path),
        onLayout: (listener) => {
          const active = this.app.workspace.on("active-leaf-change", listener);
          const layout = this.app.workspace.on("layout-change", listener);
          return () => {
            this.app.workspace.offref(active);
            this.app.workspace.offref(layout);
          };
        },
        mainMoved: (path) => mainMoved(path),
        documentFor: (path) => documentFor(this.config, path),
        onMapping: (listener) => this.settingsSaved.subscribe(listener),
        rooms,
        connections,
        report: (path, status) => board.set(path, status),
        notify: (message, path) => {
          showNotice(message);
          if (path !== undefined) board.markTold(path);
        },
        notifyActions: (message, actions, path, lasting) => {
          const shown = showNoticeWithActions(message, actions, lasting);
          if (path !== undefined) board.markTold(path);
          return shown;
        },
        closeNote: (path) => {
          for (const leaf of this.app.workspace.getLeavesOfType("markdown")) if ((leaf.view as { file?: { path?: string } }).file?.path === path) leaf.detach();
        },
        review: (request) => chooseWhatToKeep(this.app, request),
        draftBy: (path) => draftBy(path),
        joined: (path) => liveJoined(path),
        sentBase: (path, doc, since, signal) => sentBase(path, doc, since, signal),
        cameIn: (path, shown, words) => this.tellWhatCameIn(cameIn, path, shown, words),
        gitCopy: (doc, signal) => gitCopy.read(doc, signal),
        gitBases,
        ownRestarts,
        ownLinks,
        ...disk,
      }),
    );
    const api = new SpecgitApi({ server: this.config.server, version: this.manifest.version, auth, transport: obsidianTransport });
    const events = setUpEvents(this, { api, repo: () => this.config.repo, signedIn: () => auth.isSignedIn() });
    this.register(this.settingsSaved.subscribe(() => events.settingsChanged()));
    const report = setUpReport(this, {
      api,
      server: () => this.config.server,
      version: this.manifest.version,
      repository: () => this.config.repo,
      signedIn: () => auth.isSignedIn(),
      noteState: () => {
        const path = this.app.workspace.getActiveFile()?.path;
        if (!path || !documentFor(this.config, path)) return null;
        const status = board.get(path);
        return status ? wordFor(status) : "Local";
      },
    });
    const listing = (repo: string) => listRepository(api, repo, (ms) => new Promise((resume) => window.setTimeout(resume, ms)));
    const dialogs = obsidianDialogs(this.app, (title, description) => report.openForAlert(title, description), () => this.config.server);
    askCustomServer = (host) => dialogs.confirm({ title: "Sign in", description: customServerQuestion(host), confirmLabel: "Sign in", cancelLabel: "Cancel" });
    const apply = async (mapping: { repo: string; folder: string }, options?: { fromLink?: boolean }): Promise<void> => {
      const before = this.config.repo;
      await this.applyMapping(mapping, options);
      if (mapping.repo !== before) void checkConnected();
    };
    const onboarding = setUpOnboard(this, {
      api,
      server: () => this.config.server,
      binary,
      signedIn: () => auth.isSignedIn(),
      signIn,
      isWaiting: () => auth.isWaiting(),
      onAuth: (listener) => auth.onChange(listener),
      apply,
      repoChosen: () => isRepoName(this.config.repo),
    });
    const picker = setUpPick(this, {
      api,
      dialogs,
      server: () => this.config.server,
      signedIn: () => auth.isSignedIn(),
      signIn,
      settings: () => this.config,
      apply,
      onboard: () => onboarding.start(),
      unsent: () => unsent(),
      listing,
      copyIn: async (files, skipped) => void (await this.stay?.copyIn(files, skipped)),
    });
    this.addSettingTab(new SpecgitSettingTab(this.app, this, account, () => report.open(), picker));
    const lifecycle = new ConnectionLifecycle(() => sockets.sockets(), Platform.isMobile, () => rooms.retryFailed());
    this.followSignIn(auth, account, rooms, connections, gitBases);
    this.watchConnection(lifecycle, account);

    const signals = pageSignals(this, () => events.connected());
    let panel: PanelHandle | null = null;
    this.showStatus(board, () => void panel?.reveal());
    const comments = setUpComments(this, {
      server: this.config.server,
      version: this.manifest.version,
      auth,
      documentFor: (path) => documentFor(this.config, path),
      status: board,
      signedIn: () => auth.isSignedIn(),
      me: () => ({ login: this.config.login, name: this.config.displayName || null, avatarUrl: this.config.avatarUrl || null }),
      showPanel: () => panel?.reveal("comments"),
      openInSpecgit: (path) => {
        const doc = documentFor(this.config, path);
        if (doc) openExternalUrl(noteUrl(this.config.server, doc), this.config.server);
      },
      dialogs,
      live: () => events.connected(),
      signals,
    });
    this.register(() => comments.hub.setActive(null));
    this.register(
      auth.onChange((event) => {
        if (event.kind === "signed_in" && !event.over) comments.hub.refresh();
        else if (event.kind === "signed_in" || event.kind === "signed_out") comments.hub.reset();
        events.settingsChanged();
      }),
    );

    const changes = setUpChanges(this, {
      api,
      binary,
      dialogs,
      settings: () => this.config,
      bases: disk.bases,
      gitCopy: (doc) => gitCopy.read(doc),
      gitFile: (doc) => gitCopy.readFile(doc),
      gitBlobs: (repo, commit, files) => gitCopy.readBlobs(repo, commit, files),
      branchFile: (doc, branch) => gitCopy.readBranchFile(doc, branch),
      gitBlob: (doc, sha, signal) => gitCopy.readBlob(doc, sha, signal),
      signedIn: () => auth.isSignedIn(),
      viewerLogin: () => this.config.login,
      phaseOf: (path) => board.phaseOf(path),
      othersHere: (path) => board.get(path)?.others ?? 0,
      ownRestarts,
      server: () => this.config.server,
      openInSpecgit: (path) => {
        const doc = fileFor(this.config, path);
        if (doc) openExternalUrl(noteUrl(this.config.server, doc), this.config.server);
      },
      openComments: (path) => comments.hub.openCount(path),
      deletedOnMain: (path) => deletedOnMain(path),
      isLive: (path) => board.phaseOf(path) === "live",
      live: () => events.connected(),
      signals,
      stayOn: () => this.config.stayConnected,
      isPaused: (path) => {
        const doc = documentFor(this.config, path);
        return this.config.stayConnected && doc !== null && connections.isDisconnected(doc);
      },
      stopped: (path) => this.stay?.stopped(path),
      deleted: (path, at) => this.stay?.deletedOnGithub(path, at),
      deletedAt: (path) => this.stay?.deletedAt(path) ?? null,
      restored: (path) => this.stay?.restored(path),
      heldWhy: (path) => this.stay?.heldWhy(path) ?? null,
      join: (path) => void joinNote(path),
      addToMyNote: (path) => this.stay?.addToMyNote(path),
      offered: () => this.stay?.offered() ?? [],
      addOffered: () => this.stay?.addOffered(),
      touchNote: (path) => this.stay?.touched(path),
      attachmentProblems: (path, problems) => this.stay?.attachmentProblems(path, problems),
      bringFor: (path, text) => this.stay?.bringFor(path, text) ?? Promise.resolve(),
      copyIn: (files, skipped) => this.stay?.copyIn(files, skipped) ?? Promise.resolve(),
      bringInNewer: () => this.stay?.bringInNewer() ?? Promise.resolve({ brought: 0, skipped: 0 }),
      bringInDraft: (path) => this.stay?.bringInDraft(path) ?? Promise.resolve({ kind: "none" as const }),
      ownLinks,
    });
    comments.env.offline = { is: () => changes.model.offline(), subscribe: (listener) => changes.model.subscribe(listener) };
    events.onEvent((event) => {
      if (event.kind === "threads") comments.hub.heard(event);
      else if (event.kind !== "main" || event.branch === NOTE_BRANCH) changes.live.heard(event);
      if (event.kind === "review" && event.path !== undefined) this.stay?.heardDraft(event.path, event.sha);
      if (event.kind === "review" && event.branch !== undefined && event.push !== true) this.stay?.heardReview(event.branch);
    });
    events.onConnect((reconnected) => {
      comments.hub.catchUp(!reconnected);
      changes.live.catchUp(!reconnected);
    });

    repoShaOf = (path) => changes.model.vault()?.files.get(path)?.repoSha ?? null;
    isLocalOnlyNew = (path) => disk.bases.read(path).status === "none" && changes.model.isLocalOnlyNew(path);
    isDeferredLocalNew = (doc) => {
      const key = docKey(doc);
      const path = changes.model.vaultPathFor(doc.path);
      if (isLocalOnlyNew(path)) {
        deferredNew.set(key, path);
        return true;
      }
      if (changes.model.state().phase !== "ready" && deferredNew.get(key) === path) return true;
      deferredNew.delete(key);
      return false;
    };
    isDeferredTeammateDraft = (doc) => {
      if (rooms.hasActive(doc)) return false;
      const path = changes.model.vaultPathFor(doc.path);
      const askFirst = this.config.stayDrafts === "mine";
      if (!changes.model.draftsKnown()) return askFirst || this.stay?.offered().includes(path) === true;
      if (askFirst && this.config.login === "") return true;
      const { draft, sentTo, holdsDraft } = changes.model.draftInfo(path);
      if (!draft || holdsDraft) return false;
      const policy = this.stay?.policyFor(path, draft) ?? this.config.stayDrafts;
      return !follows(draft, this.config.login, sentTo, policy);
    };
    this.register(this.settingsSaved.subscribe(changes.settingsChanged));
    this.stay = setUpStay(this, {
      settings: () => this.config,
      setStayConnected: (on) => this.setStayConnected(on),
      model: changes.model,
      flows: changes.flows,
      review: changes.review,
      status: board,
      connections,
      bases: disk.bases,
      gitFile: (doc, at) => gitCopy.readFile(doc, at),
      wasDeleted: (doc) => gitCopy.wasDeleted(doc),
      renamedTo: (doc) => gitCopy.renamedTo(doc),
      gitBlobs: (repo, commit, files) => gitCopy.readBlobs(repo, commit, files),
      gitAttachment: (repo, at, path, options) => gitCopy.readAttachment(repo, at, path, options),
      gitFindAttachment: (repo, branch, notePath, embed) => gitCopy.findAttachment(repo, branch, notePath, embed),
      listing,
      gitBlob: (doc, sha) => gitCopy.readBlob(doc, sha),
      gitBlobsByOid: (repo, files) => gitCopy.readBlobs(repo, null, files, true),
      gitExist: (repo, paths) => gitCopy.readExist(repo, paths),
      branchFile: (doc, branch) => gitCopy.readBranchFile(doc, branch),
      vaultPath: (path) => changes.model.vaultPathFor(path),
      openStatus: () => void panel?.reveal("status"),
      attachmentMemory: () => changes.attachments(),
      signedIn: () => auth.isSignedIn(),
      login: () => this.config.login,
      chooseWhatToKeep: (request) => chooseWhatToKeep(this.app, request),
      dialogs,
    });
    this.register(this.settingsSaved.subscribe(() => this.stay?.settingsChanged()));
    this.register(
      changes.model.onLooked((looked) => {
        if (looked === null) return;
        for (const [key, path] of [...deferredNew]) {
          const current = documentFor(this.config, path);
          if (!current || docKey(current) !== key || !looked.files.has(path) || !isLocalOnlyNew(path)) deferredNew.delete(key);
        }
        if (this.config.stayConnected) connections.defaultsChanged();
      }),
    );
    mainMoved = (path) => changes.model.row(path)?.change.mainMoved === true;
    draftBy = (path) => changes.model.draftAuthor(path);
    liveJoined = (path) => changes.liveFiles.joined(path);
    sentBase = (path, doc, since, signal) => changes.sentBase(path, doc, since, signal);
    this.register(connections.onChoice(() => changes.model.redraw()));
    setUpNoteBar(this, { model: changes.model, isLive: (path) => board.phaseOf(path) === "live", onStatus: (listener) => board.subscribe(listener), join: (path) => void joinNote(path), addToMyNote: (path) => this.stay?.addToMyNote(path) });
    this.register(changes.model.subscribe(() => setAwareNotices(changes.model.state().aware !== null)));
    checkConnected = async () => {
      await changes.model.refresh();
      await changes.model.checkNow();
    };
    const joinNote = async (path: string): Promise<void> => {
      const doc = documentFor(this.config, path);
      if (!doc || !auth.isSignedIn()) return;
      await ensureOpen(this, path);
      connections.choose(doc, true);
    };
    unsent = async () => {
      if (changes.model.state().phase !== "ready") await changes.model.refresh();
      const { phase, rows } = changes.model.state();
      return phase === "ready" ? rows.filter((row) => row.change.kind !== "new" || row.entry !== null).length : null;
    };
    deletedOnMain = (path) => this.stay?.isKept(path) === true;

    panel = setUpConnect(this, {
      placeOf: (path) => placeOf(this.config, path),
      server: () => this.config.server,
      connections,
      status: board,
      cameIn,
      account,
      signedIn: () => auth.isSignedIn(),
      signIn,
      mapped: () => isRepoName(this.config.repo),
      repo: () => this.config.repo,
      folder: () => normalizeFolder(this.config.folder),
      stayConnected: () => this.config.stayConnected,
      setStayConnected: (on) => this.setStayConnected(on),
      chooseRepository: () => void picker.chooseRepository(),
      onboard: () => onboarding.start(),
      continueUpload: () => void onboarding.resume(),
      onboarding: { state: () => onboarding.state(), subscribe: (listener) => onboarding.subscribe(listener) },
      peopleIn: (doc) => roomPeople.read(doc),
      comments: { env: comments.env, tabs: changes },
      disconnected: () => changes.live.catchUp(),
      tryNow: () => {
        lifecycle.online();
        rooms.retryFailed(0);
        void changes.model.refresh();
      },
      dialogs,
      hasUnsentEdits: (path) => changes.model.row(path)?.change.kind !== undefined,
      signals,
    });
    this.register(this.settingsSaved.subscribe(() => panel?.model.update()));
    this.register(() => {
      closeDialogs();
      closeMenus();
    });
    const opened = panel;
    this.app.workspace.onLayoutReady(() => openOnFirstRun({ load: (key) => this.app.loadLocalStorage(key) as unknown, save: (key, value) => this.app.saveLocalStorage(key, value) }, () => opened.reveal()));
  }

  override onunload(): void {
    this.stay?.flush();
  }

  async setStayConnected(on: boolean): Promise<void> {
    const turningOn = on && !this.config.stayConnected;
    this.config.stayConnected = on;
    this.config.stayOffered = true;
    await this.saveConfig(
      on && isRepoName(this.config.repo) ? { stayPlace: stayPlaceOf(this.config) } : undefined,
      turningOn && isRepoName(this.config.repo) ? () => this.connections?.clearDisconnected(this.config.repo, { notify: false }) : undefined,
    );
  }

  recordStayPlace(): void {
    if (this.config.stayConnected && isRepoName(this.config.repo)) this.device.writeStayPlace(stayPlaceOf(this.config));
  }

  onSaved(listener: () => void): () => void {
    return this.settingsSaved.subscribe(listener);
  }

  async saveConfig(deviceOptions?: { stayPlace?: StayPlace | null }, beforeEmit?: () => void): Promise<void> {
    await this.saveData(withoutDeviceSettings(this.config));
    this.device.write(this.config, deviceOptions);
    beforeEmit?.();
    this.settingsSaved.emit();
  }

  private async applyMapping(mapping: { repo: string; folder: string }, options?: { fromLink?: boolean }): Promise<void> {
    const before = this.config.repo;
    this.config.repo = mapping.repo;
    this.config.folder = mapping.folder;
    const nextPlace = stayPlaceOf(this.config);
    let pausedFromLink = false;
    let deviceOptions: { stayPlace?: StayPlace | null } | undefined;
    if (options?.fromLink) {
      if (this.config.stayConnected) {
        const placed = this.device.readStayPlace();
        if (placed === null || !sameStayPlace(placed, nextPlace)) {
          this.config.stayConnected = false;
          pausedFromLink = true;
        }
      }
    } else if (this.config.stayConnected && isRepoName(this.config.repo)) {
      deviceOptions = { stayPlace: nextPlace };
    }
    await this.saveConfig(deviceOptions);
    if (pausedFromLink) showNotice(STAY_PAUSED_NOTICE, true);
    else if (mapping.repo !== before) this.linked();
  }

  linked(): void {
    void this.stay?.offer();
  }

  private followSignIn(auth: SpecgitAuth, account: SpecgitAccount, rooms: RoomPool, connections: Connections, gitBases: GitBases): void {
    account.onWho(() => rooms.identityChanged());
    this.register(
      auth.onChange((event) => {
        if (event.kind === "signed_in") {
          void account.beginSignIn().catch(() => undefined);
          if (event.over) {
            connections.reset();
            rooms.reset();
          }
          rooms.retryFailed(0);
          gitBases.resume();
        } else if (event.kind === "signed_out") {
          connections.reset();
          rooms.reset();
          void account.forgetLogin().catch(() => undefined);
        }
      }),
    );
    void account.learnWhoIfOwed();
  }

  private watchConnection(lifecycle: ConnectionLifecycle, account: SpecgitAccount): void {
    const askIfOwed = (): void => void account.learnWhoIfOwed();
    watchWindows(this, (win, on) => {
      on(win.document, "visibilitychange", () => {
        if (!appHidden()) {
          lifecycle.resumed();
          askIfOwed();
        } else lifecycle.hidden();
      });
      on(win, "focus", () => {
        lifecycle.resumed();
        askIfOwed();
      });
    });
    this.registerDomEvent(window, "online", () => {
      lifecycle.online();
      askIfOwed();
    });
    this.addCommand({ id: "reconnect", name: "Reconnect live notes", callback: () => lifecycle.online() });
  }

  private showStatus(board: StatusBoard, openPanel: () => void): void {
    if (Platform.isMobile) return;
    const item = this.addStatusBarItem();
    item.addClass("specgit-status-item", "mod-clickable");
    this.registerDomEvent(item, "click", openPanel);
    const show = (): void => {
      const status = board.get(this.app.workspace.getActiveFile()?.path ?? "");
      const words = statusText(status);
      item.empty();
      if (words === "") return;
      setIcon(item.createSpan({ cls: "specgit-status-mark" }), MARK_ICON);
      item.createSpan({ text: words, cls: "specgit-status-words" });
      setTooltip(item, statusTip(status ?? { phase: "local" }), { placement: "top" });
      item.toggleClass("is-live", status !== undefined && wordFor(status) === "Live" && !status.readOnly);
    };
    this.register(board.subscribe(show));
    this.registerEvent(this.app.workspace.on("file-open", show));
    this.registerEvent(this.app.workspace.on("active-leaf-change", show));
  }

  private tellWhatCameIn(board: Board<Shown[]>, path: string, shown: Shown[] | null, words?: string): ((words: string) => void) | void {
    board.set(path, shown);
    if (shown === null) return;
    return showNoticeWithAction(words ?? cameInWords(changesIn(shown)), "See changes", () => showChanges(this.app, shown));
  }
}
