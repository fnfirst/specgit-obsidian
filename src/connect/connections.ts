import { type DocumentRef, docKey as keyOf } from "../mapping";

export interface DisconnectedStore {
  load(): string[];
  save(keys: string[]): void;
}

export class Connections {
  private readonly chosen = new Map<string, boolean>();

  private readonly off: Set<string>;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly byDefault: (doc: DocumentRef) => boolean = () => false,
    private readonly store: DisconnectedStore | null = null,
  ) {
    this.off = new Set(store?.load() ?? []);
  }

  wants(doc: DocumentRef): boolean {
    const key = keyOf(doc);
    return this.chosen.get(key) ?? (this.off.has(key) ? false : this.byDefault(doc));
  }

  private keepOff(): void {
    this.store?.save([...this.off]);
  }

  choose(doc: DocumentRef, on: boolean, lasting = true): void {
    const key = keyOf(doc);
    this.chosen.set(key, on);
    if (lasting && (on ? this.off.delete(key) : (this.off.add(key), true))) this.keepOff();
    this.listeners.forEach((listener) => listener());
  }

  defaultsChanged(): void {
    this.listeners.forEach((listener) => listener());
  }

  move(from: DocumentRef, to: DocumentRef | null): void {
    const key = keyOf(from);
    const choice = this.chosen.get(key);
    const wasOff = this.off.delete(key);
    if (wasOff) {
      if (to) this.off.add(keyOf(to));
      this.keepOff();
    }
    if (choice === undefined) return;
    this.chosen.delete(key);
    if (to && (!choice || to.repo === from.repo)) this.chosen.set(keyOf(to), choice);
  }

  forget(doc: DocumentRef): void {
    this.chosen.delete(keyOf(doc));
    if (this.off.delete(keyOf(doc))) this.keepOff();
  }

  reset(): void {
    this.chosen.clear();
    this.listeners.forEach((listener) => listener());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
