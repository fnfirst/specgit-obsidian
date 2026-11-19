export type Selection = { mode: "all"; except: ReadonlySet<string> } | { mode: "only"; keys: ReadonlySet<string> };

export const ALL_SELECTED: Selection = { mode: "all", except: new Set() };

export const isSelected = (s: Selection, key: string): boolean => (s.mode === "all" ? !s.except.has(key) : s.keys.has(key));

export const SELECTION_GRACE_MS = 30_000;

export type Absences = Map<string, number>;

export function pruneSelectionAfterGrace(s: Selection, present: ReadonlySet<string>, absences: Absences, now: number): { selection: Selection; waiting: boolean } {
  const keys = s.mode === "all" ? s.except : s.keys;
  for (const key of [...absences.keys()]) if (present.has(key) || !keys.has(key)) absences.delete(key);
  const gone = new Set<string>();
  let waiting = false;
  for (const key of keys) {
    if (present.has(key)) continue;
    const since = absences.get(key) ?? now;
    absences.set(key, since);
    if (now - since >= SELECTION_GRACE_MS) {
      gone.add(key);
      absences.delete(key);
    } else waiting = true;
  }
  if (gone.size === 0) return { selection: s, waiting };
  const kept = new Set([...keys].filter((key) => !gone.has(key)));
  return { selection: s.mode === "all" ? { mode: "all", except: kept } : { mode: "only", keys: kept }, waiting };
}

export function forgetKeys(s: Selection, keys: readonly string[]): Selection {
  const drop = new Set(keys);
  if (s.mode === "all") return { mode: "all", except: new Set([...s.except].filter((key) => !drop.has(key))) };
  return { mode: "only", keys: new Set([...s.keys].filter((key) => !drop.has(key))) };
}

export function selectKeys(s: Selection, keys: readonly string[], on: boolean): Selection {
  if (s.mode === "all") {
    const except = new Set(s.except);
    for (const key of keys) {
      if (on) except.delete(key);
      else except.add(key);
    }
    return { mode: "all", except };
  }
  const next = new Set(s.keys);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return { mode: "only", keys: next };
}

export const selectAllKeys = (on: boolean): Selection => (on ? { mode: "all", except: new Set() } : { mode: "only", keys: new Set() });

export const selectOnlyKey = (key: string): Selection => ({ mode: "only", keys: new Set([key]) });
