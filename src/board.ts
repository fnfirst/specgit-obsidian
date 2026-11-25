export class Board<Value> {
  private readonly values = new Map<string, Value>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  set(path: string, value: Value | null): void {
    if (value === null) this.values.delete(path);
    else this.values.set(path, value);
    this.seq++;
    this.listeners.forEach((listener) => listener());
  }

  revision(): number {
    return this.seq;
  }

  get(path: string): Value | undefined {
    return this.values.get(path);
  }

  paths(): string[] {
    return [...this.values.keys()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
