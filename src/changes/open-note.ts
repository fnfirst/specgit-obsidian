import { type App, Keymap } from "obsidian";

export function openNote(app: Pick<App, "vault" | "workspace">, path: string, event?: MouseEvent | KeyboardEvent): void {
  const file = app.vault.getFileByPath(path);
  if (file) void app.workspace.getLeaf(event ? Keymap.isModEvent(event) : "tab").openFile(file);
}
