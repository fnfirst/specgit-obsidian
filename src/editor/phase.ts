import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { setIcon } from "obsidian";
import { MARK_ICON } from "../brand/mark";
import { statusTip, statusText } from "../status";
import type { NotePhase } from "../status";

export type Phase = "off" | NotePhase;

export const setPhase = StateEffect.define<Phase>();
export const setReader = StateEffect.define<boolean>();

export const setDeleted = StateEffect.define<boolean>();

export const deletedField = StateField.define<boolean>({
  create: () => false,
  update: (deleted, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setDeleted)) return effect.value;
    return deleted;
  },
});

export const readerField = StateField.define<boolean>({
  create: () => false,
  update: (reader, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setReader)) return effect.value;
    return reader;
  },
});

const HELD: readonly Phase[] = ["joining", "locked"];

export const phaseField = StateField.define<Phase>({
  create: () => "off",
  update: (phase, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setPhase)) return effect.value;
    return phase;
  },
  provide: (field) => [

    Prec.highest(EditorState.readOnly.computeN([field, readerField], (state) => (HELD.includes(state.field(field)) || state.field(readerField) ? [true] : []))),
    EditorView.editorAttributes.compute([field], (state): Record<string, string> => {
      const phase = state.field(field);
      return phase === "off" ? {} : { "data-specgit-room": phase };
    }),
  ],
});

export function headerActions(editor: HTMLElement): HTMLElement | null {
  return editor.closest(".workspace-leaf-content")?.querySelector<HTMLElement>(".view-header .view-actions") ?? null;
}

export const phaseBadge = ViewPlugin.fromClass(
  class {
    private readonly badge: HTMLElement;
    private shown = "";
    private full = 0;
    private watching: HTMLElement | null = null;
    private readonly resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.fit());
    private readonly words = new MutationObserver(() => {
      this.badge.classList.remove("is-compact");
      this.fit();
    });

    constructor(private readonly view: EditorView) {
      this.badge = view.dom.createDiv({ cls: "specgit-room-badge" });
      const mark = this.badge.createSpan({ cls: "specgit-room-badge-mark" });
      setIcon(mark, MARK_ICON);
      const words = this.badge.createSpan({ cls: "specgit-room-badge-words" });

      this.words.observe(words, { childList: true, characterData: true, subtree: true });
      this.draw();
      this.place();
    }

    update(update: ViewUpdate): void {

      if (!this.badge.isConnected || !this.badge.classList.contains("is-in-header")) this.place();
      if (update.startState.field(phaseField) !== update.state.field(phaseField) || update.startState.field(readerField) !== update.state.field(readerField) || update.startState.field(deletedField, false) !== update.state.field(deletedField, false)) this.draw();
    }

    destroy(): void {
      this.resize?.disconnect();
      this.words.disconnect();
      this.badge.remove();
    }

    private place(): void {
      const actions = headerActions(this.view.dom);
      if (actions) {
        if (this.badge.parentElement !== actions) actions.prepend(this.badge);
        this.badge.classList.add("is-in-header");
        this.watch(actions.closest<HTMLElement>(".view-header"));
        return;
      }
      this.badge.classList.remove("is-in-header", "is-compact");
      if (!this.badge.isConnected) this.view.dom.appendChild(this.badge);
    }

    private watch(header: HTMLElement | null): void {
      if (header === this.watching) return;
      this.resize?.disconnect();
      this.watching = header;
      if (header) this.resize?.observe(header);
    }

    private fit(): void {
      const header = this.watching;
      if (!header || !activeDocument.body.classList.contains("is-phone") || this.badge.hidden) return this.badge.classList.remove("is-compact");
      const compact = this.badge.classList.contains("is-compact");
      if (!compact) this.full = this.badge.offsetWidth;
      const others = [...(this.badge.parentElement?.children ?? [])].filter((child) => child !== this.badge).reduce((sum, child) => sum + (child as HTMLElement).offsetWidth, 0);

      const room = header.clientWidth - 96 - others - 40;
      this.badge.classList.toggle("is-compact", this.full > room);
    }

    private draw(): void {
      const phase = this.view.state.field(phaseField);
      const readOnly = this.view.state.field(readerField);
      const hidden = phase === "off" || phase === "local";
      this.badge.hidden = hidden;
      if (hidden) return;
      this.badge.setAttribute("aria-label", statusTip({ phase, readOnly, ...(this.view.state.field(deletedField, false) ? { why: "deleted" as const } : {}) }));
      this.badge.setAttribute("data-phase", phase);

      const words = statusText({ phase, online: true, readOnly, others: 0 });
      if (this.shown !== words) this.badge.querySelector(".specgit-room-badge-words")!.textContent = words;
      this.shown = words;
      this.fit();
    }
  },
);
