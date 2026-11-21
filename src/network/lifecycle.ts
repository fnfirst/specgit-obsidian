import { WebSocketStatus } from "@hocuspocus/provider";

export interface Reconnectable {
  readonly status: WebSocketStatus;
  shouldConnect: boolean;
  readonly lastMessageReceived: number;
  connect(): Promise<unknown> | void;
  disconnect(): void;
  onClose(closed: { event: { code: number; reason: string } }): void;
}

export const STALE_AFTER_MS = 30_000;

export class ConnectionLifecycle {
  constructor(
    private readonly sockets: () => Iterable<Reconnectable>,
    private readonly mobile: boolean,
    private readonly onResume: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  resumed(): void {
    for (const socket of this.sockets()) {
      if (socket.status === WebSocketStatus.Connected && !this.isStale(socket)) {
        socket.shouldConnect = true;
      } else this.restart(socket);
    }
    this.onResume();
  }

  online(): void {
    for (const socket of this.sockets()) this.restart(socket);
    this.onResume();
  }

  hidden(): void {
    if (this.mobile) this.disconnect();
  }

  disconnect(): void {
    for (const socket of this.sockets()) socket.disconnect();
  }

  private isStale(socket: Reconnectable): boolean {
    return socket.lastMessageReceived > 0 && this.now() - socket.lastMessageReceived > STALE_AFTER_MS;
  }

  private restart(socket: Reconnectable): void {
    if (socket.status === WebSocketStatus.Connected) socket.onClose({ event: { code: 4408, reason: "resumed" } });
    void socket.connect();
  }
}
