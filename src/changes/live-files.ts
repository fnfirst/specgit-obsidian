export const LIVE_FILES_AFTER_MS = 2_000;

export interface LiveFilesPorts {
  isLive(path: string): boolean;
  later(run: () => void, ms: number): () => void;
  read(path: string): Promise<string | null>;
  bring(path: string, text: string): Promise<void>;
  send(path: string): Promise<void>;
}

export class LiveFiles {
  private readonly waiting = new Map<string, () => void>();

  constructor(private readonly ports: LiveFilesPorts) {}

  changed(path: string): void {
    if (!this.ports.isLive(path)) return;
    this.waiting.get(path)?.();
    this.waiting.set(
      path,
      this.ports.later(() => {
        this.waiting.delete(path);
        void this.run(path);
      }, LIVE_FILES_AFTER_MS),
    );
  }

  joined(path: string): void {
    this.changed(path);
  }

  dispose(): void {
    for (const cancel of this.waiting.values()) cancel();
    this.waiting.clear();
  }

  private async run(path: string): Promise<void> {
    try {
      if (!this.ports.isLive(path)) return;
      const text = await this.ports.read(path);
      if (text === null) return;
      await this.ports.bring(path, text);
      await this.ports.send(path);
    } catch {
      void 0;
    }
  }
}
