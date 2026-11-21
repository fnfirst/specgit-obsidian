import { sameLogin } from "../shared/review-flow";

export type StayDrafts = "everyone" | "mine";

export interface Draft {
  branch: string;
  blob: string | null;
  by: string | null;
  prNumber: number | null;
  inGroup?: true;
  viaGroup?: true;
  removes?: ReadonlyMap<string, string | null>;
}

export const draftKey = (draft: Pick<Draft, "prNumber" | "inGroup">): string | null => (draft.prNumber === null ? null : draft.inGroup === true ? `group:${draft.prNumber}` : `pr:${draft.prNumber}`);

export function follows(draft: Pick<Draft, "by" | "prNumber" | "inGroup">, login: string, sentTo: string | null | undefined, policy: StayDrafts): boolean {
  if (policy === "everyone" || sameLogin(draft.by, login)) return true;
  const key = draftKey(draft);
  return key !== null && sentTo === key;
}

export type LeftAlone = "live" | "unsaved" | "disconnected" | "recent" | "tool";

export interface FileFacts {
  present: boolean;
  sha?: string;
  sent?: string;
  sentTo?: string;
  agreed?: string;
  unchanged: boolean;
  deletedHere: boolean;
  published: boolean;
  publishedMoved: boolean;
}

export type Ended = "published" | "discarded";

export interface CaseInput {
  file: FileFacts;
  draft: Draft | null;
  login: string;
  policy: StayDrafts;
  leftAlone: LeftAlone | null;
  ended: Ended | null;
  unreadable?: boolean;
}

export type Case =
  | { kind: "leave"; why: LeftAlone }
  | { kind: "offer" }
  | { kind: "take" | "settled" | "create" | "send" | "merge" | "meet" | "start" | "catch-up" | "end-own" | "wait" | "none" }
  | { kind: "settle" | "restore" };

export const isClean = (file: Pick<FileFacts, "sha" | "agreed" | "unchanged">): boolean => (file.agreed !== undefined ? file.sha === file.agreed : file.unchanged);

export function draftCase({ file, draft, login, policy, leftAlone, ended, unreadable }: CaseInput): Case {
  if (leftAlone !== null) return { kind: "leave", why: leftAlone };
  if (!file.present) {
    if (file.deletedHere || !draft || file.published) return { kind: "none" };
    if (!follows(draft, login, undefined, policy)) return { kind: "offer" };
    return unreadable ? { kind: "wait" } : { kind: "create" };
  }
  const clean = isClean(file);
  if (draft) {
    if (!follows(draft, login, file.sentTo, policy)) return { kind: "offer" };
    if (unreadable) return { kind: "wait" };
    const unmoved = draft.blob === null ? file.sent !== undefined : draft.blob === file.sent;
    if (clean) return unmoved || draft.blob === null ? { kind: "settled" } : { kind: "take" };
    if (file.sent === undefined) return { kind: "meet" };
    return unmoved ? { kind: "send" } : { kind: "merge" };
  }
  if (file.sent === undefined) {
    if (clean) return { kind: "none" };
    return file.publishedMoved ? { kind: "catch-up" } : { kind: "start" };
  }
  if (ended === null) return unreadable ? { kind: "wait" } : { kind: "none" };
  if (clean) return { kind: ended === "published" ? "settle" : "restore" };
  return { kind: "end-own" };
}
