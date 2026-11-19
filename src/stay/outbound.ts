import type { ChangeRow } from "../changes/model";
import type { LocalChange } from "../changes/plan";
import { BURST_FILES } from "./limits";

export const changeKey = (change: Pick<LocalChange, "kind" | "path" | "from">): string => `${change.kind}|${change.path}|${change.from ?? ""}`;

export interface OutboundInput {

  atStart: boolean;

  editsAtStart?: boolean;
  rows: readonly ChangeRow[];

  baseline: ReadonlySet<string>;

  committed: ReadonlySet<string>;

  held: ReadonlySet<string>;

  kept: ReadonlySet<string>;

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

export const isEdit = (row: ChangeRow, committed: ReadonlySet<string>): boolean => row.change.kind === "edited" || ((row.change.kind === "new" || row.change.kind === "renamed") && committed.has(changeKey(row.change)));

export function planOutbound(input: OutboundInput): OutboundPlan {
  const edits = input.edits;
  const created = input.rows.filter((row) => {
    const { kind } = row.change;
    if ((kind !== "new" && kind !== "renamed") || isEdit(row, input.committed)) return false;
    const key = changeKey(row.change);
    return !input.baseline.has(key) && !input.held.has(key) && !(kind === "new" && input.kept.has(row.change.path)) && input.allowed(row) && input.settling !== true;
  });
  const wantedAll = edits ? input.rows.filter((row) => isEdit(row, input.committed) && edits.own(row) && !edits.held(row) && input.allowed(row)) : [];
  const editsAtStart = input.editsAtStart ?? input.atStart;

  const heldAtStart = editsAtStart ? wantedAll.filter((row) => edits?.typed?.(row) !== true && edits?.after?.(row) !== true) : [];
  const wanted = wantedAll.filter((row) => !heldAtStart.includes(row));
  const waits = edits ? wanted.map((row) => edits.wait(row)) : [];
  const ready = wanted.filter((_, at) => waits[at] === 0);
  const later = waits.filter((wait) => wait > 0);
  const wait = later.length > 0 ? Math.min(...later) : null;
  const flagged = (row: ChangeRow, edit: boolean, start = false): OutboundPlan["hold"][number] => ({ key: changeKey(row.change), path: row.change.path, ...(edit ? { edit: true as const } : {}), ...(start ? { atStart: true as const } : {}) });
  const byList = (pairs: Array<{ row: ChangeRow; edit: boolean }>): Array<{ row: ChangeRow; edit: boolean }> => pairs.sort((a, b) => input.rows.indexOf(a.row) - input.rows.indexOf(b.row));

  const atStart = byList([...(input.atStart ? created : []).map((row) => ({ row, edit: false })), ...heldAtStart.map((row) => ({ row, edit: true }))]).map(({ row, edit }) => flagged(row, edit, true));
  const pending = byList([...(input.atStart ? [] : created).map((row) => ({ row, edit: false })), ...ready.map((row) => ({ row, edit: true }))]);
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
