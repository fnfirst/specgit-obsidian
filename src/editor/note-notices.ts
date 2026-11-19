const TYPING_TOLD_MS = 10_000;

export interface ShownNotice {
  shown(): boolean;
}

export class NoteNotices {
  private readonly deleted = new Map<string, ShownNotice>();
  private readonly typing = new Map<string, number>();

  deletedShown(path: string): boolean {
    return this.deleted.get(path)?.shown() ?? false;
  }

  deletedRaised(path: string, notice: ShownNotice | void): void {
    if (notice) this.deleted.set(path, notice);
    else this.deleted.delete(path);
  }

  typingDue(path: string, now: number): boolean {
    const last = this.typing.get(path);
    if (last !== undefined && now - last < TYPING_TOLD_MS) return false;
    this.typing.set(path, now);
    return true;
  }
}
