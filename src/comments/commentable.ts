import type { EditorView } from "@codemirror/view";
import type { DocumentRef } from "../mapping";
import type { CommentsHub } from "./hub";
import { insideCodeFence, type Span } from "./place";

export interface CommentableWorld {
  signedIn(): boolean;
  documentFor(path: string): DocumentRef | null;
}

export function commentableIn(view: EditorView | null, path: string, world: CommentableWorld): boolean {
  const selection = view?.state.selection.main;
  if (!view || !selection || selection.empty || !world.signedIn() || !world.documentFor(path)) return false;
  const { doc } = view.state;
  if (doc.sliceString(selection.from, selection.to).trim() === "") return false;
  return !insideCodeFence(doc.toString(), selection.from);
}

export async function startCommentOn(hub: CommentsHub, view: EditorView | null, path: string, offered: Span | null = null, lost?: () => void): Promise<void> {
  if (!view) return;
  const { doc } = view.state;
  const current = view.state.selection.main;
  const selection = current.empty ? offered : current;
  if (!selection || selection.from === selection.to) {

    lost?.();
    return;
  }
  const last = doc.lineAt(selection.to);

  const lineEnd = last.from === selection.to ? Math.max(doc.lineAt(selection.from).number, last.number - 1) : last.number;
  const started = await hub.startComment(path, { quote: doc.sliceString(selection.from, selection.to), from: selection.from, to: selection.to, lineStart: doc.lineAt(selection.from).number, lineEnd });
  const now = view.state.selection.main;
  if (started && now.from === selection.from && now.to === selection.to) view.dispatch({ selection: { anchor: selection.to } });
}
