import { type App, ButtonComponent, MarkdownView, Modal, type Workspace, type WorkspaceLeaf } from "obsidian";
import { showNotice } from "../notices";
import { drawLogo } from "./mark";

function isElementShown(el: HTMLElement | undefined): boolean {
  if (!el) return true;
  if ("isConnected" in el && !el.isConnected) return false;
  if (typeof el.isShown === "function") return el.isShown();
  return !("offsetParent" in el) || el.offsetParent !== null;
}

function shownMarkdownLeaf(leaf: WorkspaceLeaf | null | undefined, path: string): WorkspaceLeaf | null {
  if (!leaf) return null;
  const view = leaf.view;
  if (!(view instanceof MarkdownView) || view.file?.path !== path) return null;
  const el = (view as { containerEl?: HTMLElement }).containerEl;
  return isElementShown(el) ? leaf : null;
}

function captureActiveMarkdownLeaf(app: App): { leaf: WorkspaceLeaf; path: string } | null {
  const workspace = app?.workspace;
  if (!workspace || typeof workspace.getActiveFile !== "function") return null;
  const file = workspace.getActiveFile();
  if (!file) return null;
  const activeView = typeof workspace.getActiveViewOfType === "function" ? workspace.getActiveViewOfType(MarkdownView) : null;
  const direct = shownMarkdownLeaf(activeView?.leaf, file.path);
  if (direct) return { leaf: direct, path: file.path };
  const recent = typeof workspace.getMostRecentLeaf === "function" ? shownMarkdownLeaf(workspace.getMostRecentLeaf(), file.path) : null;
  if (recent) return { leaf: recent, path: file.path };
  const leaves = typeof workspace.getLeavesOfType === "function" ? workspace.getLeavesOfType("markdown") : [];
  let fallback: WorkspaceLeaf | null = null;
  for (const leaf of leaves) {
    const match = shownMarkdownLeaf(leaf, file.path);
    if (!match) continue;
    const leafEl = (match.view as { containerEl?: HTMLElement }).containerEl?.closest?.(".workspace-leaf");
    if (leafEl?.classList.contains("mod-active")) return { leaf: match, path: file.path };
    fallback ??= match;
  }
  return fallback ? { leaf: fallback, path: file.path } : null;
}

function hasOtherModalOpen(doc: Document | null | undefined, selfContainer: HTMLElement | undefined): boolean {
  if (shown.size > 0) return true;
  if (!doc || typeof doc.getElementsByClassName !== "function") return false;
  for (const el of doc.getElementsByClassName("modal-container")) {
    if (el !== selfContainer) return true;
  }
  return false;
}

function currentDocument(): Document | null {
  return typeof activeDocument === "undefined" ? null : activeDocument;
}

function isAttachedMarkdownLeaf(workspace: Workspace | undefined, leaf: WorkspaceLeaf, path: string): boolean {
  if (!workspace || !(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== path) return false;
  if (typeof workspace.getLeavesOfType === "function" && !workspace.getLeavesOfType("markdown").includes(leaf)) return false;
  const el = (leaf.view as { containerEl?: HTMLElement }).containerEl;
  return !el || !("isConnected" in el) || el.isConnected;
}

export abstract class SpecgitModal extends Modal {
  private returnTarget: { leaf: WorkspaceLeaf; path: string } | null = null;

  constructor(app: App) {
    super(app);
    this.modalEl.addClass("specgit-modal");
    brandOver(this.titleEl);
  }

  override open(): void {
    const activeDoc = currentDocument();
    const modalDoc = this.containerEl?.ownerDocument ?? activeDoc;
    const otherModalOpen = hasOtherModalOpen(modalDoc, this.containerEl);
    const target = otherModalOpen ? null : captureActiveMarkdownLeaf(this.app);
    this.returnTarget = target;
    if (target) {
      const viewEl = (target.leaf.view as { containerEl?: HTMLElement }).containerEl;
      const focusDoc = viewEl?.ownerDocument ?? activeDoc;
      const activeEl = focusDoc?.activeElement ?? null;
      const inReturnLeaf = Boolean(viewEl && activeEl && typeof viewEl.contains === "function" && viewEl.contains(activeEl));
      if (!inReturnLeaf) this.shouldRestoreSelection = false;
    } else if (!otherModalOpen) {
      const activeEl = (modalDoc ?? activeDoc)?.activeElement ?? null;
      const activeLeafEl = activeEl && typeof activeEl.closest === "function" ? activeEl.closest(".workspace-leaf") : null;
      if (activeLeafEl && !activeLeafEl.classList.contains("mod-active")) this.shouldRestoreSelection = false;
    }
    shown.add(this);
    super.open();
  }

  override close(): void {
    const wasShown = shown.delete(this);
    const target = this.returnTarget;
    this.returnTarget = null;
    super.close();
    if (!wasShown || !target) return;
    const activeDoc = currentDocument();
    const modalDoc = this.containerEl?.ownerDocument ?? activeDoc;
    if (hasOtherModalOpen(modalDoc, this.containerEl)) return;
    const workspace = this.app?.workspace;
    if (!isAttachedMarkdownLeaf(workspace, target.leaf, target.path)) return;
    workspace.setActiveLeaf?.(target.leaf, { focus: true });
  }
}

function brandOver(title: HTMLElement): void {
  const header = title.parentElement;
  if (!header) return;
  const brand = header.createDiv({ cls: "specgit-modal-brand" });
  drawLogo(brand.createSpan({ cls: "specgit-modal-logo" })).setAttribute("aria-hidden", "true");
  const word = brand.createSpan({ cls: "specgit-wordmark" });
  word.append("spec");
  word.createSpan({ cls: "specgit-wordmark-git" }).append("git");
  header.insertBefore(brand, title);
}

const shown = new Set<SpecgitModal>();

export function closeDialogs(): void {
  for (const modal of [...shown]) modal.close();
}

export const OPEN_IN_ANOTHER_WINDOW = "This is already open in another Obsidian window.";

export function bringForward(modal: Modal): boolean {
  const there = modal.modalEl.ownerDocument.defaultView;
  if (there === null) return false;
  const container = modal.containerEl;
  container.parentElement?.append(container);
  container.querySelector<HTMLElement>("input, button")?.focus();
  const here = typeof activeWindow === "undefined" ? window : activeWindow;
  if (there === here) {
    const keymap = modal.app?.keymap;
    if (modal.scope && keymap) {
      keymap.popScope(modal.scope);
      keymap.pushScope(modal.scope);
    }
    return true;
  }
  if (typeof there.focus === "function") there.focus();
  showNotice(OPEN_IN_ANOTHER_WINDOW);
  return true;
}

export function openDialogs(): SpecgitModal[] {
  return [...shown];
}

export interface ButtonRow {
  addButton(fill: (button: ButtonComponent) => unknown): ButtonRow;
}

export function buttonRow(parent: HTMLElement): ButtonRow {
  const container = parent.createDiv({ cls: "modal-button-container" });
  const row: ButtonRow = {
    addButton: (fill) => {
      fill(new ButtonComponent(container));
      return row;
    },
  };
  return row;
}
