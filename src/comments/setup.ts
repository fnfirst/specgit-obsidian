import { Component, MarkdownRenderer, Notice, Platform, type Plugin, type Editor, type MarkdownFileInfo, type MarkdownView } from "obsidian";
import { MARK_ICON } from "../brand/mark";
import { type Bearer } from "../auth/bearer";
import { obsidianTransport } from "../auth/obsidian-transport";
import type { Dialogs } from "../changes/flow-deps";
import type { DocumentRef } from "../mapping";
import { linkifyMentions, mediaAsWords, type PollSignals, type ThreadsStoreDeps } from "../shared/review-flow";
import type { StatusBoard } from "../status";
import { CommentsApi } from "./api";
import { CommentsHub } from "./hub";
import { CommentMarks } from "./marks";
import { commentableIn, startCommentOn } from "./commentable";
import type { Span } from "./place";
import type { CommentsTabEnv } from "./tab";
import { toolbarOffer, type ToolbarWorld } from "./toolbar";
import { PLUGIN_COMMENT_WORDS } from "./words";
import { appHidden, watchWindows } from "../windows";

export interface CommentsSetup {
  server: string;
  version: string;
  auth: Bearer;
  documentFor: (path: string) => DocumentRef | null;
  status: StatusBoard;
  signedIn: () => boolean;
  me: ThreadsStoreDeps["me"];
  showPanel: () => void | Promise<void>;
  openInSpecgit: (path: string) => void;
  dialogs: Pick<Dialogs, "alert" | "confirm">;
  live?: () => boolean;
}

export interface CommentsParts {
  hub: CommentsHub;
  env: CommentsTabEnv;
  marks: CommentMarks;
}

export function pageSignals(plugin: Plugin, live?: () => boolean): PollSignals {
  const page = { input: Number.NEGATIVE_INFINITY, activity: Date.now() };
  const shown = new Set<() => void>();
  const focusedCallbacks = new Set<() => void>();
  const activeCallbacks = new Set<() => void>();
  const typed = (): void => {
    page.input = Date.now();
    activeCallbacks.forEach((callback) => callback());
  };
  const touched = (): void => {
    page.activity = Date.now();
    activeCallbacks.forEach((callback) => callback());
  };
  const options = { capture: true, passive: true } as const;
  watchWindows(plugin, (win, on) => {
    for (const type of ["keydown", "beforeinput", "compositionend", "paste"] as const) on(win.document, type, typed, options);
    for (const type of ["pointerdown", "pointermove", "wheel", "scroll", "touchstart"] as const) on(win.document, type, touched, options);
    on(win, "focus", touched, options);
    on(win, "focus", () => focusedCallbacks.forEach((callback) => callback()));
    on(win.document, "visibilitychange", () => {
      if (appHidden()) return;
      touched();
      shown.forEach((callback) => callback());
    });
  });
  return {
    now: Date.now,
    hidden: appHidden,
    focused: () => activeDocument.hasFocus(),
    ...(live ? { live } : {}),
    lastInputAt: () => page.input,
    lastActivityAt: () => Math.max(page.activity, page.input),
    onShown(callback) {
      shown.add(callback);
      return () => void shown.delete(callback);
    },
    onFocused(callback) {
      focusedCallbacks.add(callback);
      return () => void focusedCallbacks.delete(callback);
    },
    onActive(callback) {
      activeCallbacks.add(callback);
      return () => void activeCallbacks.delete(callback);
    },
  };
}

export function setUpComments(plugin: Plugin, deps: CommentsSetup): CommentsParts {
  const { app } = plugin;
  const { workspace, vault } = app;
  const marks = new CommentMarks();
  const api = new CommentsApi({ server: deps.server, version: deps.version, auth: deps.auth, transport: obsidianTransport });

  const markdownViewOf = (path: string): MarkdownView | undefined =>
    workspace.getLeavesOfType("markdown").flatMap((leaf) => ((leaf.view as MarkdownView).file?.path === path ? [leaf.view as MarkdownView] : []))[0];

  const error = (title: string, description: string): void => {
    new Notice(
      createFragment((fragment) => {
        fragment.createEl("strong", { text: title });
        fragment.createDiv({ text: description });
      }),
      8_000,
    );
  };

  const hub = new CommentsHub({
    marks,
    api,
    documentFor: deps.documentFor,
    signedIn: deps.signedIn,
    me: deps.me,
    isLive: (path) => deps.status.phaseOf(path) === "live",
    saveNote: async (path) => {
      await markdownViewOf(path)?.save();
      const status = deps.status.get(path);
      if (status?.phase === "live" && !status.online) throw new Error(PLUGIN_COMMENT_WORDS.notReachable);
    },
    error,
    stay: (title, description) =>
      void new Notice(
        createFragment((fragment) => {
          fragment.createEl("strong", { text: title });
          fragment.createDiv({ text: description });
        }),
        0,
      ),
    alert: (title, description) => deps.dialogs.alert({ title, description }),
    discardUnsent: (quote) =>
      deps.dialogs.confirm({
        title: PLUGIN_COMMENT_WORDS.unsent.title,
        description: PLUGIN_COMMENT_WORDS.unsent.description(quote),
        confirmLabel: PLUGIN_COMMENT_WORDS.unsent.discard,
        cancelLabel: PLUGIN_COMMENT_WORDS.unsent.keep,
        destructive: true,
      }),
    showPanel: deps.showPanel,
    afterJump: () => {
      if (Platform.isMobile) workspace.rightSplit.collapse();
    },
    signals: pageSignals(plugin, deps.live),
    every: (run, ms) => {
      const id = window.setInterval(run, ms);
      plugin.registerInterval(id);
      return () => window.clearInterval(id);
    },
    wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    later: (run, ms) => void window.setTimeout(run, ms),
  });

  const selectionListeners = new Set<() => void>();
  const selectionChanged = (): void => selectionListeners.forEach((listener) => listener());
  const editorSelectionListeners = new Set<() => void>();

  plugin.registerEditorExtension(
    marks.extension({
      selected: (read) => {
        if (!read) editorSelectionListeners.forEach((listener) => listener());
        selectionChanged();
      },
      clicked: (path, threadId) => {
        const note = hub.forNote(path);
        if (!note) return;
        if (threadId === null) note.deselect();
        else note.select(threadId, "mark");
      },
    }),
  );

  const follow = (): void => {
    hub.setActive(workspace.getActiveFile()?.path ?? null);
    selectionChanged();
  };
  plugin.registerEvent(workspace.on("active-leaf-change", follow));
  plugin.registerEvent(workspace.on("file-open", follow));
  plugin.registerEvent(
    vault.on("rename", (_file, oldPath) => {
      hub.forget(oldPath);
      follow();
    }),
  );
  plugin.registerEvent(vault.on("delete", (file) => hub.forget(file.path)));
  workspace.onLayoutReady(follow);

  const comment = (editor: Editor, path: string, offered: Span | null = null, lost?: () => void): void => void startCommentOn(hub, marks.editorFor(editor), path, offered, lost);

  const commentable = (info: MarkdownView | MarkdownFileInfo | null, editor: Editor): string | null => {
    const path = info?.file?.path;
    return path && commentableIn(marks.editorFor(editor), path, deps) ? path : null;
  };

  plugin.registerEvent(
    workspace.on("editor-menu", (menu, editor, info) => {
      const path = commentable(info, editor);
      if (!path) return;
      const view = marks.editorFor(editor);
      const selected = view?.state.selection.main;
      if (view && selected && !selected.empty) marks.offer(view, { from: selected.from, to: selected.to });
      menu.addItem((item) => item.setTitle(PLUGIN_COMMENT_WORDS.menuItem).setIcon(MARK_ICON).onClick(() => comment(editor, path, view ? marks.offeredNow(view) : null, () => void new Notice(PLUGIN_COMMENT_WORDS.menuWordsChanged))));
    }),
  );
  plugin.addCommand({
    id: "comment-on-selection",
    name: PLUGIN_COMMENT_WORDS.commandName,
    icon: MARK_ICON,
    editorCheckCallback: (checking, editor, info) => {
      const path = commentable(info, editor);
      if (!path) return false;
      if (!checking) comment(editor, path);
      return true;
    },
  });

  const toolbar = Platform.isMobile ? toolbarOffer(app as unknown as ToolbarWorld, `${plugin.manifest.id}:comment-on-selection`) : null;

  const env: CommentsTabEnv = {
    hub,
    renderBody: (element, markdown) => {
      const component = new Component();
      component.load();
      void MarkdownRenderer.render(app, linkifyMentions(mediaAsWords(markdown)), element, "", component).then(() => {
        element.querySelectorAll("pre > code.language-suggestion").forEach((code) => {
          const block = code.parentElement;
          if (!block) return;
          block.addClass("specgit-suggestion");
          block.parentElement?.insertBefore(createEl("p", { cls: "specgit-suggestion-label", text: PLUGIN_COMMENT_WORDS.after }), block);
        });
      });
      return () => component.unload();
    },
    canApply: (path) => {
      const view = marks.editorOf(path);
      return !!view && !view.state.readOnly;
    },
    mobile: Platform.isMobile,
    toolbar,
    told: (message) => void new Notice(message),
    canComment: (path) => commentableIn(marks.editorOf(path), path, deps),
    startComment: (path) => startCommentOn(hub, marks.editorOf(path), path),
    onSelection: (listener) => {
      selectionListeners.add(listener);
      return () => void selectionListeners.delete(listener);
    },
    onEditorSelection: (listener) => {
      editorSelectionListeners.add(listener);
      return () => void editorSelectionListeners.delete(listener);
    },
    openInSpecgit: deps.openInSpecgit,
    offline: { is: () => false, subscribe: () => () => undefined },
    openUrl: (url) => void (/^https:\/\//i.test(url) && window.open(url)),
    error,
    now: Date.now,
  };
  return { hub, env, marks };
}
