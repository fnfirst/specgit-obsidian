import { type EventRead, EventReload, RETURN_SECOND_READ_MS, type SettleDeps } from "./live-events";
import { timeout } from "./timer";

export const THREADS_POLL_MS = 15_000;
export const SAFETY_POLL_MS = 5 * 60_000;
export const TYPING_POLL_MS = 180_000;
export const IDLE_AFTER_MS = 120_000;
export const IDLE_FOCUSED_AFTER_MS = 30 * 60_000;
export const FOCUS_POLL_FLOOR_MS = 10_000;

let drawn: number | null = null;
export function clientPollOffset(periodMs: number, random: () => number = Math.random): number {
  drawn ??= random();
  return Math.floor(drawn * periodMs);
}
export function resetClientPollOffset(random?: () => number): void {
  drawn = random ? random() : null;
}

export interface PollSignals {
  now(): number;
  hidden(): boolean;
  lastInputAt(): number;
  lastActivityAt(): number;
  focused?(): boolean;
  live?(): boolean;
  onShown(cb: () => void): () => void;
  onFocused?(cb: () => void): () => void;
  onActive?(cb: () => void): () => void;
}

export interface PollGate {
  due(): boolean;
  ran(): void;
  onShown(poll: () => void, deps?: SettleDeps): () => void;
  onFocused(poll: () => void, deps?: SettleDeps): () => void;
  reaction(read: EventRead, deps?: SettleDeps): EventReload;
}

export function createPollGateFor(signals: PollSignals): PollGate {
  let lastPollAt = Number.NEGATIVE_INFINITY;
  const reactions = new Set<EventReload>();
  const idle = (): boolean => signals.now() - signals.lastActivityAt() >= (signals.focused?.() ? IDLE_FOCUSED_AFTER_MS : IDLE_AFTER_MS);
  const returnRead = (poll: () => void, deps: SettleDeps | undefined): { read(): void; stop(): void } => {
    const later = deps?.later ?? timeout;
    let cancel: (() => void) | null = null;
    const stop = (): void => {
      cancel?.();
      cancel = null;
    };
    return {
      stop,
      read() {
        poll();
        stop();
        cancel = later(() => {
          cancel = null;
          if (!signals.hidden()) poll();
        }, RETURN_SECOND_READ_MS);
      },
    };
  };
  return {
    due() {
      if (signals.hidden()) return false;
      const t = signals.now();
      if (idle()) return false;
      if (signals.live?.()) return t - lastPollAt >= SAFETY_POLL_MS;
      if (t - signals.lastInputAt() < TYPING_POLL_MS) return t - lastPollAt >= TYPING_POLL_MS;
      return true;
    },
    ran() {
      lastPollAt = signals.now();
      reactions.forEach((reaction) => reaction.paid());
    },
    onShown(poll, deps) {
      const back = returnRead(poll, deps);
      const unsubscribe = signals.onShown(() => {
        if (signals.now() - lastPollAt >= THREADS_POLL_MS) back.read();
      });
      return () => {
        unsubscribe();
        back.stop();
      };
    },
    onFocused(poll, deps) {
      const back = returnRead(poll, deps);
      const unsubscribe =
        signals.onFocused?.(() => {
          if (signals.hidden()) return;
          if (signals.now() - lastPollAt >= FOCUS_POLL_FLOOR_MS) back.read();
        }) ?? (() => {});
      return () => {
        unsubscribe();
        back.stop();
      };
    },
    reaction: (read, deps) => {
      const reaction = new EventReload(read, {
          hidden: () => signals.hidden(),
          idle,
          onShown: (cb) => signals.onShown(cb),
          ...(signals.onFocused ? { onFocused: (cb: () => void) => signals.onFocused!(cb) } : {}),
          ...(signals.onActive ? { onActive: (cb: () => void) => signals.onActive!(cb) } : {}),
        }, deps);
      reactions.add(reaction);
      return reaction;
    },
  };
}
