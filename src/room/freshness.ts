import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { BRIDGE_FIELD, CAUGHT_UP_KEY, MARKDOWN_META_ROOT } from "../protocol";
import type { Landed, RefusalRange } from "./own-changes";

export function showsBridge(doc: Y.Doc, awareness: Awareness, clients: Iterable<number>): boolean {
  const caughtUp: unknown = doc.getMap(MARKDOWN_META_ROOT).get(CAUGHT_UP_KEY);
  if (typeof caughtUp !== "string" || caughtUp === "") return false;
  for (const client of clients) {
    const bridge: unknown = awareness.getStates().get(client)?.[BRIDGE_FIELD];
    if (typeof bridge === "object" && bridge !== null && (bridge as { session?: unknown }).session === caughtUp) return true;
  }
  return false;
}

const rangeOf = (value: unknown): RefusalRange | null => {
  const { start, end } = (typeof value === "object" && value !== null ? value : {}) as { start?: unknown; end?: unknown };
  return Array.isArray(start) && Array.isArray(end) ? { start: start as number[], end: end as number[] } : null;
};

export interface Refusal {
  n: number;
  range: RefusalRange | null;
  why: "riff" | "schema";
  landed: Landed | null;
}

export interface Refused {
  count: number;
  recent: Refusal[];
}

export function refusedBy(awareness: Awareness, clients: Iterable<number>): Map<string, Refused> {
  const seen = new Map<string, Refused>();
  for (const client of clients) {
    const bridge: unknown = awareness.getStates().get(client)?.[BRIDGE_FIELD];
    if (typeof bridge !== "object" || bridge === null) continue;
    const { session, refused, refusals } = bridge as { session?: unknown; refused?: unknown; refusals?: unknown };
    if (typeof session !== "string" || session === "") continue;
    const recent = (Array.isArray(refusals) ? refusals : []).slice(-8).flatMap((one: unknown): Refusal[] => {
      const { n, range, why, client, clock } = (typeof one === "object" && one !== null ? one : {}) as { n?: unknown; range?: unknown; why?: unknown; client?: unknown; clock?: unknown };
      return typeof n === "number" && Number.isInteger(n) ? [{ n, range: rangeOf(range), why: why === "schema" ? "schema" : "riff", landed: Number.isInteger(client) && Number.isInteger(clock) ? { client: client as number, clock: clock as number } : null }] : [];
    });
    seen.set(session, { count: typeof refused === "number" && Number.isFinite(refused) ? refused : 0, recent });
  }
  return seen;
}

export const isFresh = (doc: Y.Doc, awareness: Awareness): boolean => showsBridge(doc, awareness, awareness.getStates().keys());

export function watchFreshness(doc: Y.Doc, awareness: Awareness, onChange: () => void): () => void {
  const meta = doc.getMap(MARKDOWN_META_ROOT);
  meta.observe(onChange);
  awareness.on("change", onChange);
  return () => {
    meta.unobserve(onChange);
    awareness.off("change", onChange);
  };
}
