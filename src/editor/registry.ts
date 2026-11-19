export class NoteRegistry<Editor extends object> {
  private readonly editors = new Map<string, Editor[]>();

  add(path: string, editor: Editor): boolean {
    const open = this.editors.get(path) ?? [];
    open.push(editor);
    this.editors.set(path, open);
    return open[0] === editor;
  }

  remove(path: string, editor: Editor): Editor | null {
    const open = this.editors.get(path);
    if (!open) return null;
    const index = open.indexOf(editor);
    if (index < 0) return null;
    open.splice(index, 1);
    if (open.length === 0) this.editors.delete(path);
    return index === 0 ? (open[0] ?? null) : null;
  }

  move(from: string, to: string): void {
    const open = this.editors.get(from);
    if (!open) return;
    this.editors.delete(from);
    this.editors.set(to, open);
  }

  editorsOf(path: string): readonly Editor[] {
    return this.editors.get(path) ?? [];
  }
}
