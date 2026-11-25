import { StateEffect, StateField } from "@codemirror/state";
import { type EditorView, type Panel, showPanel } from "@codemirror/view";
import { ADD_TO_MY_NOTE, JOIN, noteBarDraft, noteBarLive } from "./aware-words";
import type { AwareRow } from "./aware";

export interface BarLine {
  kind: "choice" | "live" | "draft";
  words: string;
  action: { label: string; run: () => void };
}

export function barLines(row: AwareRow | undefined, live: boolean, doing: { join: () => void; add: () => void }, panelShown: boolean, choice?: { words: string; label: string; run: () => void }): BarLine[] {
  const lines: BarLine[] = [];
  if (choice) lines.push({ kind: "choice", words: `${choice.words} ${choice.label}.`, action: { label: choice.label, run: choice.run } });
  if (row?.who && !live && !panelShown) lines.push({ kind: "live", words: noteBarLive(row.who.names, row.who.many), action: { label: JOIN, run: doing.join } });
  const draft = row?.draft;
  const draftWho = !draft || draft.inNote !== false ? "" : !draft.mine ? draft.others : (draft.lastOther ?? "");
  if (draftWho !== "") lines.push({ kind: "draft", words: noteBarDraft(draftWho, draftWho.includes(" and ") || draftWho.includes(", ")), action: { label: ADD_TO_MY_NOTE, run: doing.add } });
  return lines;
}

export const setBar = StateEffect.define<readonly BarLine[]>();

function drawBar(lines: readonly BarLine[]): Panel {
  const dom = createDiv({ cls: "specgit-note-bar" });
  dom.setAttribute("data-testid", "aware-note-bar");
  dom.setAttribute("role", "status");
  for (const line of lines) {
    const row = dom.createDiv({ cls: "specgit-note-bar-line", attr: { "data-kind": line.kind } });
    row.createSpan({ cls: "specgit-note-bar-words", text: line.words });
    row.createEl("button", { text: line.action.label, cls: "specgit-note-bar-action" }, (button) =>
      button.addEventListener("click", (event) => {
        event.preventDefault();
        line.action.run();
      }),
    );
  }
  return { dom, top: true };
}

export const noteBar = StateField.define<readonly BarLine[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBar)) return effect.value;
    return value;
  },
  provide: (field) => showPanel.from(field, (lines) => (lines.length === 0 ? null : (): Panel => drawBar(lines))),
});

export const sameLines = (a: readonly BarLine[], b: readonly BarLine[]): boolean => a.length === b.length && a.every((line, at) => line.kind === b[at]!.kind && line.words === b[at]!.words && line.action.label === b[at]!.action.label);

export function showBar(view: EditorView, lines: readonly BarLine[]): void {
  void Promise.resolve().then(() => {
    try {
      if (sameLines(view.state.field(noteBar, false) ?? [], lines)) return;
      view.dispatch({ effects: setBar.of(lines) });
    } catch {
      void 0;
    }
  });
}
