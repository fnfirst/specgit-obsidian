import { type App, ButtonComponent, Modal } from "obsidian";
import { showNotice } from "../notices";
import { drawLogo } from "./mark";

export abstract class SpecgitModal extends Modal {
  constructor(app: App) {
    super(app);
    this.modalEl.addClass("specgit-modal");
    brandOver(this.titleEl);
  }

  override open(): void {
    shown.add(this);
    super.open();
  }

  override close(): void {
    shown.delete(this);
    super.close();
  }
}

function brandOver(title: HTMLElement): void {
  const header = title.parentElement;
  if (!header) return;
  const doc = title.ownerDocument;
  const brand = doc.createElement("div");
  brand.className = "specgit-modal-brand";
  const logo = doc.createElement("span");
  logo.className = "specgit-modal-logo";
  drawLogo(logo).setAttribute("aria-hidden", "true");
  const word = doc.createElement("span");
  word.className = "specgit-wordmark";
  const git = doc.createElement("span");
  git.className = "specgit-wordmark-git";

  git.append("git");
  word.append("spec", git);
  brand.append(logo, word);
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
