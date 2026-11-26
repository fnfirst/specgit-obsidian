import { type DocumentRef, docKey, fileFor } from "../mapping";

export const PLUGIN_OUTDATED_BANNER = "This version of specgit is out of date. Update it in Community plugins.";

class OutdatedRooms {
  private readonly entries = new Map<string, { owner: object; message: string }>();
  private readonly listeners = new Set<() => void>();

  mark(ref: DocumentRef, owner: object, message = PLUGIN_OUTDATED_BANNER): void {
    const key = docKey(ref);
    const current = this.entries.get(key);
    if (current && current.owner === owner && current.message === message) return;
    this.entries.set(key, { owner, message });
    this.emit();
  }

  clear(ref: DocumentRef, owner: object): void {
    const key = docKey(ref);
    const current = this.entries.get(key);
    if (!current || current.owner !== owner) return;
    this.entries.delete(key);
    this.emit();
  }

  clearRef(ref: DocumentRef): void {
    const key = docKey(ref);
    if (!this.entries.delete(key)) return;
    this.emit();
  }

  messageFor(ref: DocumentRef): string | null {
    return this.entries.get(docKey(ref))?.message ?? null;
  }

  messageForNote(repo: string, folder: string, path: string | null | undefined): string | null {
    if (!repo || !path) return null;
    const doc = fileFor({ repo, folder }, path);
    return doc ? this.messageFor(doc) : null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const outdatedRooms = new OutdatedRooms();
