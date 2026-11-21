import type { ChangeSetEntry } from "./change-set";
import { isSomeoneElses, unitKey, type StatusUnits } from "./status-list";
import { ALL_SELECTED, forgetKeys, pruneSelectionAfterGrace, selectKeys, type Selection } from "./selection";

export interface SelectionMemory {
  selection: Selection;
  absences: ReadonlyMap<string, number>;
  offered: ReadonlySet<string>;
  arriving: ReadonlySet<string>;
}

export const freshSelectionMemory = (selection: Selection = ALL_SELECTED): SelectionMemory => ({ selection, absences: new Map(), offered: new Set(), arriving: new Set() });

export interface SelectionUnit {
  key: string;
  authorLogin: string | null;
  group?: true;
  ownerUnknown?: true;
  startsUnchecked?: boolean;
}

export function keepSelection(memory: SelectionMemory, units: readonly SelectionUnit[], viewer: string | null, now: number): SelectionMemory {
  const present = new Set(units.map((unit) => unit.key));
  const arriving = new Set([...memory.arriving].filter((key) => !present.has(key)));
  const absences = new Map(memory.absences);
  let selection = pruneSelectionAfterGrace(memory.selection, new Set([...present, ...arriving]), absences, now).selection;
  const unchecked = new Set(units.filter((unit) => unit.startsUnchecked === true || isSomeoneElses({ authorLogin: unit.authorLogin, ...(unit.ownerUnknown ? { ownerUnknown: true as const } : {}) }, viewer, unit.group === true)).map((unit) => unit.key));
  const offered = new Set([...memory.offered].filter((key) => unchecked.has(key)));
  const fresh = [...unchecked].filter((key) => !offered.has(key));
  for (const key of fresh) offered.add(key);
  if (selection.mode === "all" && fresh.length > 0) selection = selectKeys(selection, fresh, false);
  return { selection, absences, offered, arriving };
}

export const expectArrival = (memory: SelectionMemory, key: string): SelectionMemory => ({ ...memory, arriving: new Set([...memory.arriving, key]) });

export const settleArrivals = (memory: SelectionMemory): SelectionMemory => ({ ...memory, arriving: new Set() });

export function forgetJoined(memory: SelectionMemory, keys: readonly string[]): SelectionMemory {
  const absences = new Map(memory.absences);
  for (const key of keys) absences.delete(key);
  const joined = new Set(keys);
  return { ...memory, selection: forgetKeys(memory.selection, keys), absences, offered: new Set([...memory.offered].filter((key) => !joined.has(key))) };
}

export const withSelection = (memory: SelectionMemory, selection: Selection): SelectionMemory => ({ ...memory, selection });

export function selectionUnits(model: StatusUnits, startsUnchecked: (entry: ChangeSetEntry) => boolean = () => false): SelectionUnit[] {
  return [
    ...model.groups.map((group) => ({ key: unitKey(group.entry), authorLogin: group.entry.authorLogin, group: true as const })),
    ...model.loose.map((entry) => ({ key: unitKey(entry), authorLogin: entry.authorLogin, ...(entry.ownerUnknown ? { ownerUnknown: true as const } : {}), startsUnchecked: startsUnchecked(entry) })),
  ];
}
