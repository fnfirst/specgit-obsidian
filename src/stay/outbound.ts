import type { CacheEntry } from "../changes/cache";
import type { ChangeRow, Looked } from "../changes/model";
import type { LocalChange } from "../changes/plan";
import { sameLogin } from "../shared/review-flow";
import type { Draft } from "./draft-state";
import { BURST_FILES } from "./limits";

export const changeKey = (change: Pick<LocalChange, "kind" | "path" | "from">): string => `${change.kind}|${change.path}|${change.from ?? ""}`;

export type LookedDrafts = Pick<Looked, "drafts" | "files"> | null;

export interface BlockedNew {
  baseline: ReadonlySet<string>;
  held: ReadonlySet<string>;
  kept: ReadonlySet<string>;
}

export interface OwnDraftContext {
  looked: LookedDrafts;
  login: string;
  blockedNew?: BlockedNew;
}

export const hasOwnOrAgreedDraft = (
  entry: Pick<CacheEntry, "sent" | "agreed"> | undefined,
  draft: Pick<Draft, "by"> | undefined,
  login: string,
): boolean => entry?.sent !== undefined || entry?.agreed !== undefined || (draft !== undefined && sameLogin(draft.by, login));

export const hasOwnOrAgreedRow = (row: ChangeRow, looked: LookedDrafts, login: string): boolean =>
  (row.entry !== null && (row.entry.authorLogin == null || sameLogin(row.entry.authorLogin, login))) ||
  hasOwnOrAgreedDraft(looked?.files.get(row.change.path), looked?.drafts?.byPath.get(row.change.path), login);

export const isBlockedNew = (change: Pick<LocalChange, "kind" | "path" | "from">, blocked: BlockedNew | undefined): boolean => {
  if (blocked === undefined) return false;
  const key = changeKey(change);
  return blocked.baseline.has(key) || blocked.held.has(key) || (change.kind === "new" && blocked.kept.has(change.path));
};

export interface OutboundInput {
  atStart: boolean;
  editsAtStart?: boolean;
  rows: readonly ChangeRow[];
  looked?: LookedDrafts;
  login?: string;
  baseline: ReadonlySet<string>;
  committed: ReadonlySet<string>;
  held: ReadonlySet<string>;
  kept: ReadonlySet<string>;
  released?: ReadonlySet<string>;
  suspect(path: string): boolean;
  allowed(row: ChangeRow): boolean;
  settling?: boolean;
  edits?: {
    own(row: ChangeRow): boolean;
    held(row: ChangeRow): boolean;
    wait(row: ChangeRow): number;
    typed?(row: ChangeRow): boolean;
    after?(row: ChangeRow): boolean;
  };
}

export interface OutboundPlan {
  send: ChangeRow[];
  hold: Array<{ key: string; path: string; edit?: true; atStart?: true }>;
  burst: number | null;
  wait: number | null;
}

export const isEdit = (row: ChangeRow, committed: ReadonlySet<string>, ctx?: OwnDraftContext): boolean => {
  if (row.change.kind === "edited") return true;
  if (row.change.kind !== "new" && row.change.kind !== "renamed") return false;
  if (isBlockedNew(row.change, ctx?.blockedNew)) return false;
  if (committed.has(changeKey(row.change))) return true;
  if (!ctx?.looked) return false;
  return hasOwnOrAgreedDraft(ctx.looked.files.get(row.change.path), ctx.looked.drafts?.byPath.get(row.change.path), ctx.login);
};

export function planOutbound(input: OutboundInput): OutboundPlan {
  const edits = input.edits;
  const editCtx: OwnDraftContext = {
    looked: input.looked ?? null,
    login: input.login ?? "",
    blockedNew: { baseline: input.baseline, held: input.held, kept: input.kept },
  };
  const created = input.rows.filter((row) => {
    const { kind } = row.change;
    if ((kind !== "new" && kind !== "renamed") || isEdit(row, input.committed, editCtx)) return false;
    return !isBlockedNew(row.change, editCtx.blockedNew) && input.allowed(row) && input.settling !== true;
  });
  const isReleased = (row: ChangeRow): boolean => input.released?.has(row.change.path) === true;
  const wantedAll = edits ? input.rows.filter((row) => isEdit(row, input.committed, editCtx) && edits.own(row) && !edits.held(row) && input.allowed(row)) : [];
  const editsAtStart = input.editsAtStart ?? input.atStart;
  const heldAtStart = editsAtStart ? wantedAll.filter((row) => !isReleased(row) && edits?.typed?.(row) !== true && edits?.after?.(row) !== true) : [];
  const wanted = wantedAll.filter((row) => !heldAtStart.includes(row));
  const waits = edits ? wanted.map((row) => edits.wait(row)) : [];
  const ready = wanted.filter((_, at) => waits[at] === 0);
  const later = waits.filter((wait) => wait > 0);
  const wait = later.length > 0 ? Math.min(...later) : null;
  const flagged = (row: ChangeRow, edit: boolean, start = false): OutboundPlan["hold"][number] => ({ key: changeKey(row.change), path: row.change.path, ...(edit ? { edit: true as const } : {}), ...(start ? { atStart: true as const } : {}) });
  const byList = (pairs: Array<{ row: ChangeRow; edit: boolean }>): Array<{ row: ChangeRow; edit: boolean }> => pairs.sort((a, b) => input.rows.indexOf(a.row) - input.rows.indexOf(b.row));
  const atStartCreated = input.atStart ? created.filter((row) => !isReleased(row)) : [];
  const pendingCreated = input.atStart ? created.filter((row) => isReleased(row)) : created;
  const atStart = byList([...atStartCreated.map((row) => ({ row, edit: false })), ...heldAtStart.map((row) => ({ row, edit: true }))]).map(({ row, edit }) => flagged(row, edit, true));
  const pending = byList([...pendingCreated.map((row) => ({ row, edit: false })), ...ready.map((row) => ({ row, edit: true }))]);
  const soonest = wait;
  if (pending.length > BURST_FILES) return { send: [], hold: [...atStart, ...pending.map(({ row, edit }) => flagged(row, edit))], burst: pending.length, wait: soonest };
  const hold: OutboundPlan["hold"] = [];
  const send: ChangeRow[] = [];
  for (const { row, edit } of pending) {
    const { path, from } = row.change;
    if (input.suspect(path) || (from !== undefined && input.suspect(from))) hold.push(flagged(row, edit));
    else send.push(row);
  }
  return { send, hold: [...atStart, ...hold], burst: null, wait: soonest };
}
