const OTHER_EDITORS = ".hover-popover, .canvas-node, .markdown-embed, .table-cell-wrapper, table";

export function isNoteEditor(dom: Element): boolean {
  if (dom.closest(OTHER_EDITORS) || !dom.closest(".workspace-leaf")) return false;
  return (dom.closest(".workspace-leaf-content")?.getAttribute("data-type") ?? "markdown") === "markdown";
}
