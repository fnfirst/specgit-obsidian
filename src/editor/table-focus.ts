import { EditorView } from "@codemirror/view";

export interface CellFocus {

  table: number;
  row: number;
  cell: number;

  anchor: number;
  head: number;

  element: Element;
}

const inner = (cell: Element): EditorView | null => {
  const dom = cell.querySelector<HTMLElement>(".cm-editor");
  return dom ? EditorView.findFromDOM(dom) : null;
};

export function cellFocus(view: EditorView): CellFocus | null {
  const active = view.dom.ownerDocument.activeElement;
  if (!active || !view.dom.contains(active)) return null;
  const cell = active.closest("td, th");
  const table = cell?.closest("table");
  const row = cell?.closest("tr");
  if (!cell || !table || !row || !view.dom.contains(table)) return null;
  const editor = inner(cell);
  if (!editor) return null;
  const { anchor, head } = editor.state.selection.main;
  const length = editor.state.doc.length;
  return {
    table: [...view.dom.querySelectorAll("table")].indexOf(table),
    row: [...table.rows].indexOf(row),
    cell: (cell as HTMLTableCellElement).cellIndex,
    anchor: length - anchor,
    head: length - head,
    element: active,
  };
}

const REDRAW_MS = 1000;

function press(cell: Element): void {
  const win = cell.ownerDocument.defaultView;
  if (!win) return;
  const { left, top, width, height } = cell.getBoundingClientRect();
  const init = { pointerId: 1, isPrimary: true, button: 0, pointerType: "mouse", clientX: left + width / 2, clientY: top + height / 2 };
  const Pointer = win.PointerEvent ?? win.MouseEvent;

  const event = (type: string, extra: EventInit): Event => Object.defineProperty(new Pointer(type, { ...init, ...extra }), "view", { value: win });
  cell.dispatchEvent(event("pointerdown", { bubbles: true, cancelable: true }));

  cell.dispatchEvent(event("click", { bubbles: true, cancelable: true }));
  win.dispatchEvent(event("pointerup", {}));
}

function place(editor: EditorView, focus: CellFocus): void {
  const end = editor.state.doc.length;
  editor.dispatch({ selection: { anchor: Math.max(0, end - focus.anchor), head: Math.max(0, end - focus.head) } });
}

function keep(focus: CellFocus): boolean {
  const cell = focus.element.closest("td, th");
  const editor = cell ? inner(cell) : null;
  if (!editor) return false;
  const { anchor, head } = editor.state.selection.main;
  const end = editor.state.doc.length;
  if (anchor !== 0 || head !== 0 || (focus.anchor >= end && focus.head >= end)) return false;
  place(editor, focus);
  return true;
}

function settle(view: EditorView, focus: CellFocus, pressed: { done: boolean }): boolean {
  const doc = view.dom.ownerDocument;
  if (focus.element.isConnected) return doc.activeElement !== focus.element || keep(focus);
  const cell = view.dom.querySelectorAll("table")[focus.table]?.rows[focus.row]?.cells[focus.cell];
  const there = cell !== undefined && cell.contains(doc.activeElement);
  if (!there && doc.activeElement && doc.activeElement !== doc.body) return true;
  if (!cell) return false;
  let editor = inner(cell);
  if (!editor && !pressed.done) {
    pressed.done = true;
    press(cell);

    editor = inner(cell);
  }
  if (!editor) return false;
  editor.focus();
  place(editor, focus);
  return true;
}

export function restoreCellFocus(view: EditorView, focus: CellFocus): void {
  const pressed = { done: false };
  if (settle(view, focus, pressed)) return;
  const win = view.dom.ownerDocument.defaultView ?? window;
  const stop = (): void => {
    observer.disconnect();
    win.clearTimeout(timer);
  };
  const observer = new win.MutationObserver(() => settle(view, focus, pressed) && stop());
  const timer = win.setTimeout(stop, REDRAW_MS);
  observer.observe(view.dom, { childList: true, subtree: true });
}
