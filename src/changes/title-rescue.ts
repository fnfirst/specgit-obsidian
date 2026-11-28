import { EditorView } from "@codemirror/view";
import { editorInfoField, type Plugin } from "obsidian";

export const UNTITLED_PRE_TITLE_MAX_MS = 600;

export type BufferedInputSkip = { kind: "insertText" | "deleteContentBackward"; data?: string; at: number } | null;

export interface TitleRescueState {
  el: HTMLElement;
  leafEl: Element | null;
  expectedPath: string | null;
  win: Window | null;
  pendingBodyChars: string;
  expiresAt: number;
  skipBeforeInput: BufferedInputSkip;
}

export interface PreTitleRescueState {
  expiresAt: number;
  win: Window | null;
  originTitleEl: HTMLElement | null;
  originCmEl: HTMLElement | null;
  originPath: string | null;
  flushingTitleEl?: HTMLElement | null;
  pendingTitleChars: string;
  pendingBodyChars: string;
  submitted: boolean;
  skipBeforeInput: BufferedInputSkip;
}

const syntheticTitleEnterEvents = new WeakSet<Event>();

export function isSyntheticTitleEnter(event: Event): boolean {
  return syntheticTitleEnterEvents.has(event);
}

export function isRelayedKeyEvent(event: Event): boolean {
  return (event as { isRelayed?: unknown }).isRelayed === true;
}

export function popLastCodePoint(text: string): string {
  return text.length > 0 ? Array.from(text).slice(0, -1).join("") : "";
}

export function consumeBufferedBeforeInput(
  holder: { skipBeforeInput: BufferedInputSkip },
  ie: InputEvent,
  now: number,
  canDelete: boolean,
  onInsert: (data: string) => void,
  onDelete: () => void,
): boolean {
  if (ie.inputType === "insertText" && typeof ie.data === "string" && ie.data.length > 0) {
    ie.preventDefault();
    ie.stopImmediatePropagation();
    const skipped =
      holder.skipBeforeInput?.kind === "insertText" &&
      holder.skipBeforeInput.data === ie.data &&
      now - holder.skipBeforeInput.at <= 16;
    holder.skipBeforeInput = null;
    if (!skipped) onInsert(ie.data);
    return true;
  }
  if (ie.inputType === "deleteContentBackward") {
    const skipped = holder.skipBeforeInput?.kind === "deleteContentBackward" && now - holder.skipBeforeInput.at <= 16;
    holder.skipBeforeInput = null;
    if (skipped) {
      ie.preventDefault();
      ie.stopImmediatePropagation();
      return true;
    }
    if (canDelete) {
      ie.preventDefault();
      ie.stopImmediatePropagation();
      onDelete();
      return true;
    }
  }
  return false;
}

export function inlineTitleElementOf(target: unknown): HTMLElement | null {
  if (!target || typeof target !== "object") return null;
  const el = target as { classList?: { contains?: (name: string) => boolean }; closest?: (selector: string) => unknown };
  if (
    typeof el.classList?.contains === "function" &&
    (el.classList.contains("inline-title") || el.classList.contains("view-header-title"))
  ) {
    return target as HTMLElement;
  }
  const found = typeof el.closest === "function" ? el.closest(".inline-title, .view-header-title") : null;
  return found && typeof found === "object" ? (found as HTMLElement) : null;
}

export function isInlineTitleElement(target: unknown): boolean {
  return inlineTitleElementOf(target) !== null;
}

export function cmContentElementOf(target: unknown): HTMLElement | null {
  if (!target || typeof target !== "object") return null;
  const el = target as { classList?: { contains?: (name: string) => boolean }; closest?: (selector: string) => unknown };
  if (typeof el.classList?.contains === "function" && el.classList.contains("cm-content")) return target as HTMLElement;
  const found = typeof el.closest === "function" ? el.closest(".cm-content") : null;
  return found && typeof found === "object" ? (found as HTMLElement) : null;
}

export function leafEditorPathOf(leafEl: Element | null): string | null {
  const scope: ParentNode | null = leafEl;
  const cmEl = scope?.querySelector?.(".cm-content") ?? null;
  if (!(cmEl && typeof cmEl === "object")) return null;
  return EditorView.findFromDOM(cmEl as HTMLElement)?.state.field(editorInfoField, false)?.file?.path ?? null;
}

export function currentDoc(): Document | null {
  if (typeof activeDocument !== "undefined") return activeDocument;
  if (typeof window !== "undefined") return window.document;
  return null;
}

export function focusedInlineTitle(doc: Document | null = currentDoc()): HTMLElement | null {
  const active = doc?.activeElement ?? null;
  return inlineTitleElementOf(active);
}

export function isRescueTargetActive(rescue: TitleRescueState | null, target: EventTarget | null, now: number): rescue is TitleRescueState {
  if (!rescue || now >= rescue.expiresAt) return false;
  const titleEl = inlineTitleElementOf(target);
  if (titleEl !== rescue.el) return false;
  const doc = rescue.el.ownerDocument ?? currentDoc();
  const active = doc?.activeElement ?? null;
  return active === null || active === rescue.el || rescue.el.contains(active);
}

export function flushRescuedChars(plugin: Plugin, cmContent: HTMLElement, chars: string, expectedPath: string | null): void {
  const activeEditor = (plugin.app?.workspace as { activeEditor?: { editor?: { cm?: unknown; replaceSelection?: (text: string) => void } } } | undefined)?.activeEditor?.editor;
  const view = EditorView.findFromDOM(cmContent) ?? (activeEditor?.cm instanceof EditorView ? activeEditor.cm : null);
  if (view) {
    if (view.state.readOnly) return;
    if (expectedPath !== null) {
      const viewPath = view.state.field(editorInfoField, false)?.file?.path ?? null;
      if (viewPath !== null && viewPath.toLowerCase() !== expectedPath.toLowerCase()) return;
    }
    const { from, to, head } = view.state.selection.main;
    const anchor = Math.min(from, head);
    view.dispatch({
      userEvent: "input.type",
      changes: { from, to, insert: chars },
      selection: { anchor: anchor + chars.length },
    });
    return;
  }
  if (typeof activeEditor?.replaceSelection === "function") activeEditor.replaceSelection(chars);
}

export function isBlockedPreTitleFocusTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const candidate = target as { closest?: (selector: string) => unknown; parentElement?: Element | null };
  const el = typeof candidate.closest === "function" ? candidate : candidate.parentElement;
  return typeof el?.closest === "function" && el.closest(".modal-container, .prompt, input, textarea") !== null;
}

function isBlockedPreTitleTarget(target: unknown, originTitleEl: HTMLElement | null, flushingTitleEl: HTMLElement | null | undefined): boolean {
  const targetTitle = inlineTitleElementOf(target);
  if (targetTitle !== null) return targetTitle !== originTitleEl && targetTitle !== flushingTitleEl;
  return isBlockedPreTitleFocusTarget(target);
}

function activePreTitleOf(
  holder: { preTitle: PreTitleRescueState | null },
  event: Event,
  now: number,
): PreTitleRescueState | null {
  const pre = holder.preTitle;
  if (pre === null) return null;
  if (now >= pre.expiresAt) {
    holder.preTitle = null;
    return null;
  }
  const doc = (event.target as Node | null)?.ownerDocument ?? currentDoc();
  const win = doc?.defaultView ?? null;
  if (pre.win !== null && win !== null && win !== pre.win) return null;
  const focusedTitle = focusedInlineTitle(doc);
  if (focusedTitle !== null && focusedTitle !== pre.originTitleEl && focusedTitle !== pre.flushingTitleEl) return null;
  if (isBlockedPreTitleTarget(event.target, pre.originTitleEl, pre.flushingTitleEl)) return null;
  return pre;
}

export function handlePreTitleKeyDown(
  holder: { preTitle: PreTitleRescueState | null },
  event: Event,
  ke: KeyboardEvent,
  key: string,
  now: number,
): boolean {
  const pre = activePreTitleOf(holder, event, now);
  if (pre === null) return false;
  if (key === "Escape") {
    holder.preTitle = null;
    return true;
  }
  if (ke.ctrlKey || ke.metaKey || ke.altKey || ke.isComposing || key === "Process") return false;
  if (key === "Enter" && !ke.shiftKey && pre.pendingTitleChars.length > 0) {
    ke.preventDefault();
    ke.stopImmediatePropagation();
    if (pre.submitted) pre.pendingBodyChars += "\n";
    else pre.submitted = true;
    return true;
  }
  if (key === "Backspace" && pre.pendingTitleChars.length > 0) {
    ke.preventDefault();
    ke.stopImmediatePropagation();
    if (pre.submitted) pre.pendingBodyChars = popLastCodePoint(pre.pendingBodyChars);
    else pre.pendingTitleChars = popLastCodePoint(pre.pendingTitleChars);
    pre.skipBeforeInput = { kind: "deleteContentBackward", at: now };
    return true;
  }
  if (key.length === 1) {
    ke.preventDefault();
    ke.stopImmediatePropagation();
    if (pre.submitted) pre.pendingBodyChars += key;
    else pre.pendingTitleChars += key;
    pre.skipBeforeInput = { kind: "insertText", data: key, at: now };
    return true;
  }
  return false;
}

export function handlePreTitleBeforeInput(
  holder: { preTitle: PreTitleRescueState | null },
  event: Event,
  now: number,
): boolean {
  const pre = activePreTitleOf(holder, event, now);
  if (pre === null) return false;
  return consumeBufferedBeforeInput(
    pre,
    event as InputEvent,
    now,
    pre.pendingTitleChars.length > 0,
    (data) => {
      if (pre.submitted) pre.pendingBodyChars += data;
      else pre.pendingTitleChars += data;
    },
    () => {
      if (pre.submitted) pre.pendingBodyChars = popLastCodePoint(pre.pendingBodyChars);
      else pre.pendingTitleChars = popLastCodePoint(pre.pendingTitleChars);
    },
  );
}

export function flushPreTitleOnFocus(
  holder: { preTitle: PreTitleRescueState | null; rescue: TitleRescueState | null; activePath: () => string | null },
  titleEl: HTMLElement,
  now: number,
  rescueMaxMs: number,
  isDisposed: () => boolean,
  isUntitled: (path: string) => boolean,
  onSeedPostEnter: (at: number) => void,
): void {
  const pre = holder.preTitle;
  if (pre === null) return;
  const doc = titleEl.ownerDocument ?? currentDoc();
  if (!isElementShown(titleEl, doc)) return;
  const titleWin = doc?.defaultView ?? null;
  if (pre.win !== null && titleWin !== null && titleWin !== pre.win) return;
  const rawNow = (titleEl.textContent ?? "").trim();
  const rawNowUntitled = rawNow === "" || /^Untitled(?: \d+)?$/i.test(rawNow);
  if (!rawNowUntitled) {
    const activeNow = holder.activePath();
    if (activeNow !== null && !isUntitled(activeNow)) return;
  }
  if (now >= pre.expiresAt || pre.pendingTitleChars.length === 0) {
    holder.preTitle = null;
    return;
  }
  if (pre.flushingTitleEl === titleEl) return;
  pre.flushingTitleEl = titleEl;
  queueMicrotask(() => {
    if (holder.preTitle === pre) holder.preTitle = null;
    else return;
    if (isDisposed() || !titleEl.isConnected || pre.pendingTitleChars.length === 0) return;
    const currentText = titleEl.textContent ?? "";
    const raw = currentText.trim();
    const rawIsUntitled = raw === "" || /^Untitled(?: \d+)?$/i.test(raw);
    if (titleEl === pre.originTitleEl) {
      const active = holder.activePath();
      if (!rawIsUntitled && active !== null && !isUntitled(active)) return;
    }
    const nextTitle = rawIsUntitled ? pre.pendingTitleChars : `${pre.pendingTitleChars}${currentText}`;
    titleEl.textContent = nextTitle;
    const sel = typeof doc?.getSelection === "function" ? doc.getSelection() : null;
    if (sel && typeof doc?.createRange === "function") {
      try {
        const range = doc.createRange();
        range.selectNodeContents(titleEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {
        void 0;
      }
    }
    const InputEventCtor =
      titleWin && typeof (titleWin as { InputEvent?: unknown }).InputEvent === "function"
        ? (titleWin as { InputEvent: typeof InputEvent }).InputEvent
        : typeof InputEvent === "function"
          ? InputEvent
          : null;
    const EventCtor =
      titleWin && typeof (titleWin as { Event?: unknown }).Event === "function"
        ? (titleWin as { Event: typeof Event }).Event
        : Event;
    titleEl.dispatchEvent(
      InputEventCtor
        ? new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: nextTitle })
        : new EventCtor("input", { bubbles: true }),
    );
    if (pre.submitted) {
      const at = Date.now();
      onSeedPostEnter(at);
      const leafEl = typeof titleEl.closest === "function" ? titleEl.closest(".workspace-leaf") : null;
      const leafPath = leafEditorPathOf(leafEl);
      const activeAtEnter = holder.activePath();
      const expectedPath =
        leafPath ??
        (activeAtEnter !== null &&
        isUntitled(activeAtEnter) &&
        (titleEl === pre.originTitleEl || activeAtEnter !== pre.originPath)
          ? activeAtEnter
          : null);
      holder.rescue = {
        el: titleEl,
        leafEl,
        expectedPath,
        win: titleWin ?? (typeof window !== "undefined" ? window : null),
        pendingBodyChars: pre.pendingBodyChars,
        expiresAt: at + rescueMaxMs,
        skipBeforeInput: null,
      };
      const KeyEventCtor =
        titleWin && typeof (titleWin as { KeyboardEvent?: unknown }).KeyboardEvent === "function"
          ? (titleWin as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent
          : KeyboardEvent;
      const enterEv = new KeyEventCtor("keydown", { key: "Enter", bubbles: true, cancelable: true });
      syntheticTitleEnterEvents.add(enterEv);
      titleEl.dispatchEvent(enterEv);
    }
  });
}

export function flushPreTitleToEditor(
  plugin: Plugin,
  holder: { preTitle: PreTitleRescueState | null; activePath: () => string | null },
  cmContent: HTMLElement,
  now: number,
  isDisposed: () => boolean,
  isUntitled: (path: string) => boolean,
): void {
  const pre = holder.preTitle;
  if (pre === null) return;
  holder.preTitle = null;
  const targetWin = cmContent.ownerDocument?.defaultView ?? null;
  const viewPath = EditorView.findFromDOM(cmContent)?.state.field(editorInfoField, false)?.file?.path ?? null;
  const activeNow = holder.activePath();
  const eligiblePath = viewPath !== null ? isUntitled(viewPath) : activeNow === null || isUntitled(activeNow);
  if (
    now < pre.expiresAt &&
    pre.pendingTitleChars.length > 0 &&
    (pre.win === null || targetWin === null || targetWin === pre.win) &&
    eligiblePath
  ) {
    const expected = viewPath ?? (activeNow !== null && isUntitled(activeNow) ? activeNow : null);
    const textToFlush = pre.submitted ? `${pre.pendingTitleChars}\n${pre.pendingBodyChars}` : pre.pendingTitleChars;
    queueMicrotask(() => {
      if (isDisposed() || !cmContent.isConnected) return;
      const activeAtFlush = EditorView.findFromDOM(cmContent)?.state.field(editorInfoField, false)?.file?.path ?? holder.activePath();
      if (activeAtFlush !== null && !isUntitled(activeAtFlush)) return;
      flushRescuedChars(plugin, cmContent, textToFlush, expected);
    });
  }
}

function isInActiveLeaf(el: HTMLElement, doc: Document | null): boolean {
  const leaf = typeof el.closest === "function" ? el.closest(".workspace-leaf") : null;
  if (leaf === null) return true;
  if (leaf.classList.contains("mod-active")) return true;
  return !doc?.querySelector?.(".workspace-leaf.mod-active");
}

function vaultShowInlineTitle(plugin: Plugin): boolean | undefined {
  const vault = plugin.app?.vault as { getConfig?: (key: string) => unknown } | undefined;
  const raw = typeof vault?.getConfig === "function" ? vault.getConfig("showInlineTitle") : undefined;
  return typeof raw === "boolean" ? raw : undefined;
}

function closestLeafOf(target: unknown): Element | null {
  if (!target || typeof target !== "object") return null;
  const el = target as { closest?: (selector: string) => Element | null };
  return typeof el.closest === "function" ? el.closest(".workspace-leaf") : null;
}

function isElementShown(el: Element, doc: Document | null): boolean {
  const candidate = el as HTMLElement & { isShown?: () => boolean };
  if (typeof candidate.isShown === "function") return candidate.isShown();
  if (candidate.hidden || candidate.style?.display === "none") return false;
  const win = doc?.defaultView;
  if (win && typeof win.getComputedStyle === "function") return win.getComputedStyle(candidate).display !== "none";
  return typeof getComputedStyle !== "function" || getComputedStyle(candidate).display !== "none";
}

export function willFocusInlineTitle(plugin: Plugin, target: unknown, doc: Document | null): boolean {
  const leaf = closestLeafOf(target) ?? doc?.querySelector?.(".workspace-leaf.mod-active") ?? null;
  const scope: ParentNode | null = leaf ?? doc;
  if (vaultShowInlineTitle(plugin) !== false) {
    const found = scope?.querySelector?.(".inline-title") ?? null;
    if (found && typeof found === "object" && isElementShown(found, doc)) return true;
  }
  const foundHeader = scope?.querySelector?.(".view-header-title") ?? null;
  if (foundHeader && typeof foundHeader === "object" && isElementShown(foundHeader, doc)) return true;
  return false;
}

export function settlePreTitleOnFileOpen(
  plugin: Plugin,
  holder: {
    preTitle: PreTitleRescueState | null;
    rescue: TitleRescueState | null;
    focusedTitleEl: HTMLElement | null;
    dismissedTitleEl: HTMLElement | null;
    activePath: () => string | null;
  },
  opened: string | null,
  now: number,
  rescueMaxMs: number,
  isDisposed: () => boolean,
  isUntitled: (path: string) => boolean,
  onSeedPostEnter: (at: number) => void,
): void {
  const pre = holder.preTitle;
  if (pre === null || opened === null) return;
  if (!isUntitled(opened) || now >= pre.expiresAt) {
    holder.preTitle = null;
    return;
  }
  const doc = pre.win?.document ?? currentDoc();
  const active = doc?.activeElement ?? null;
  const activeTitle = inlineTitleElementOf(active);
  if (activeTitle !== null) {
    const raw = (activeTitle.textContent ?? "").trim();
    if (isInActiveLeaf(activeTitle, doc) && (raw === "" || /^Untitled(?: \d+)?$/i.test(raw))) {
      pre.originTitleEl = null;
      pre.originCmEl = null;
      pre.originPath = null;
      holder.focusedTitleEl = activeTitle;
      holder.dismissedTitleEl = null;
      flushPreTitleOnFocus(holder, activeTitle, now, rescueMaxMs, isDisposed, isUntitled, onSeedPostEnter);
    }
    return;
  }
  const activeCm = cmContentElementOf(active);
  if (activeCm !== null) {
    const viewPath = EditorView.findFromDOM(activeCm)?.state.field(editorInfoField, false)?.file?.path ?? null;
    if (isInActiveLeaf(activeCm, doc) && (viewPath === null || isUntitled(viewPath))) {
      pre.originTitleEl = null;
      pre.originCmEl = null;
      pre.originPath = null;
      if (!willFocusInlineTitle(plugin, activeCm, doc)) {
        flushPreTitleToEditor(plugin, holder, activeCm, now, isDisposed, isUntitled);
      }
    }
    return;
  }
  pre.originTitleEl = null;
  pre.originCmEl = null;
  pre.originPath = null;
}
