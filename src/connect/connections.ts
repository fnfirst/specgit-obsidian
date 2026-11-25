import { type DocumentRef, docKey as keyOf } from "../mapping";

export interface DisconnectedStore {
  load(): string[];
  save(keys: string[]): void;
}

export class Connections {
  private readonly chosen = new Map<string, boolean>();
  private readonly off: Set<string>;
  private readonly listeners = new Set<() => void>();
  private readonly choiceListeners = new Set<() => void>();

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

  isDisconnected(doc: DocumentRef): boolean {
    const key = keyOf(doc);
    return this.chosen.get(key) === false || (this.chosen.get(key) === undefined && this.off.has(key));
  }

  private keepOff(): void {
    this.store?.save([...this.off]);
  }

  private notifyChoices(): void {
    this.listeners.forEach((listener) => listener());
    this.choiceListeners.forEach((listener) => listener());
  }

  choose(doc: DocumentRef, on: boolean, lasting = true): void {
    const key = keyOf(doc);
    if (on && this.byDefault(doc)) this.chosen.delete(key);
    else this.chosen.set(key, on);
    const offChanged = lasting && (on ? this.off.delete(key) : !this.off.has(key) && (this.off.add(key), true));
    if (offChanged) this.keepOff();
    this.notifyChoices();
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

  clearChosenOn(doc: DocumentRef): void {
    const key = keyOf(doc);
    if (this.chosen.get(key) === true) this.chosen.delete(key);
  }

  clearDisconnected(repo?: string, options: { notify?: boolean } = {}): void {
    const prefix = repo !== undefined ? `${repo}\0` : null;
    const matches = (key: string): boolean => prefix === null || key.startsWith(prefix);
    let offChanged = false;
    let chosenChanged = false;
    for (const key of [...this.off]) {
      if (matches(key)) {
        this.off.delete(key);
        offChanged = true;
      }
    }
    for (const [key, on] of [...this.chosen]) {
      if (!on && matches(key)) {
        this.chosen.delete(key);
        chosenChanged = true;
      }
    }
    if (!offChanged && !chosenChanged) return;
    if (offChanged) this.keepOff();
    if (options.notify !== false) this.notifyChoices();
  }

  reset(): void {
    this.chosen.clear();
    this.notifyChoices();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChoice(listener: () => void): () => void {
    this.choiceListeners.add(listener);
    return () => this.choiceListeners.delete(listener);
  }
}
