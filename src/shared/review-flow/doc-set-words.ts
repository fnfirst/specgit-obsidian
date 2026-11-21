import type { ChangeSetEntry } from "./change-set";
import { unitKey, type GroupPlan, type Noun } from "./status-list";

export const documentsIn = (entry: Pick<ChangeSetEntry, "group">): number => entry.group?.files ?? 1;

export interface DocSetCounts {
  thisIn: boolean;
  ownGroup: boolean;
  others: number;
  total: number;
  units: number;
  hasGroup: boolean;
}

export function docSetCounts(selected: readonly ChangeSetEntry[], ownKey: string, ownGroup: boolean): DocSetCounts {
  const thisIn = selected.some((entry) => unitKey(entry) === ownKey);
  const others = selected.filter((entry) => unitKey(entry) !== ownKey).reduce((n, entry) => n + documentsIn(entry), 0);
  const own = selected.find((entry) => unitKey(entry) === ownKey);
  return { thisIn, ownGroup, others, total: others + (own ? documentsIn(own) : 0), units: selected.length, hasGroup: selected.some((entry) => entry.group !== undefined) };
}

export function docSetLabel(
  kind: "submit" | "approve" | "publish",
  documents: number,
  thisIn: boolean,
  { group = false, hasGroup = group, units = group ? 1 : documents }: { group?: boolean; hasGroup?: boolean; units?: number } = {},
): string {
  const other = (n: number) => (n === 1 ? "1 other document" : `${n} other documents`);
  const what =
    thisIn && group && units === 1
      ? "this group"
      : hasGroup
        ? `${units} ${units === 1 ? "review" : "reviews"}`
        : thisIn
          ? documents === 1
            ? "this document"
            : `${documents} documents`
          : other(documents);
  return kind === "submit" ? `Submit ${what}` : kind === "approve" ? `Approve ${what}` : `Publish ${what}`;
}

export const idleSelectWords = (noun: Noun = "document"): string => `Select a ${noun}`;
export const IDLE_SELECT_DOCUMENTS = idleSelectWords();

export const othersTitle = (count: number): string => `${count} more in progress`;

export const SELECT_ALL_WORDS = { label: "Select all" } as const;

export const CALM_SECTION_TITLE = { conflicts: "Conflicts", draft: "Drafts", review: "In review", published: "Published" } as const;

export type SelectionAction = { kind: "group" | "add"; label: string } | { kind: "blocked"; label: string; reason: string; upgrade?: true; retry?: true };

export function selectionAction(plan: GroupPlan): SelectionAction {
  if (plan.kind !== null) return { kind: plan.kind === "create" ? "group" : "add", label: plan.label };
  return { kind: "blocked", label: plan.label, reason: plan.reason, ...(plan.upgrade ? { upgrade: true as const } : {}), ...(plan.retry ? { retry: true as const } : {}) };
}

export const UNGROUP_TIP = { name: "Ungroup", line: "Each file goes back to its own review. Nothing is lost." } as const;

export function selectionCount(selected: readonly ChangeSetEntry[]): string {
  if (selected.length === 0) return SELECT_ALL_WORDS.label;
  const documents = selected.reduce((n, entry) => n + documentsIn(entry), 0);
  return `${documents} selected · ${selected.length} ${selected.length === 1 ? "review" : "reviews"}`;
}

export function listStepLabel(kind: "submit" | "approve" | "publish", selected: readonly ChangeSetEntry[], noun: Noun = "document"): string {
  const documents = selected.reduce((n, entry) => n + documentsIn(entry), 0);
  const hasGroup = selected.some((entry) => entry.group !== undefined);
  const what = hasGroup ? (selected.length === 1 ? "this group" : `${selected.length} reviews`) : documents === 1 ? `1 ${noun}` : `${documents} ${noun}s`;
  return kind === "submit" ? `Submit ${what}` : kind === "approve" ? `Approve ${what}` : `Publish ${what}`;
}
