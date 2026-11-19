import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";

export const BACKOFF = { delay: 300, initialDelay: 0, minDelay: 300, maxDelay: 30_000, factor: 2, jitter: true, maxAttempts: 0 } as const;

export const rejoinDelay = (attempt: number): number => Math.min(BACKOFF.minDelay * BACKOFF.factor ** attempt, BACKOFF.maxDelay);

export const MAX_DOCUMENTS_PER_SOCKET = 90;

export interface Lease {
  readonly socket: HocuspocusProviderWebsocket;
  release(): void;
}

interface Entry {
  socket: HocuspocusProviderWebsocket;
  leases: number;
}

export class SocketPool {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly make: (url: string) => HocuspocusProviderWebsocket = (url) => new HocuspocusProviderWebsocket({ url, ...BACKOFF })) {}

  lease(url: string): Lease {
    let entry = this.entries.get(url);
    if (entry && entry.leases >= MAX_DOCUMENTS_PER_SOCKET) throw new Error("Too many notes are open live at once. Close some and try again.");
    if (!entry) {
      entry = { socket: this.make(url), leases: 0 };
      this.entries.set(url, entry);
    }
    entry.leases++;
    const held = entry;
    let released = false;
    return {
      socket: held.socket,
      release: () => {
        if (released) return;
        released = true;
        if (--held.leases > 0) return;
        held.socket.destroy();
        if (this.entries.get(url) === held) this.entries.delete(url);
      },
    };
  }

  sockets(): HocuspocusProviderWebsocket[] {
    return [...this.entries.values()].map((entry) => entry.socket);
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.socket.destroy();
    this.entries.clear();
  }
}
