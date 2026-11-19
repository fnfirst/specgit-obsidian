import { addIcon } from "obsidian";
import { MARK_ICON, MARK_SVG } from "./mark";

export function registerMark(): void {
  addIcon(MARK_ICON, MARK_SVG);
}
