export const FIRST_RUN_KEY = "specgit-panel-opened";

export interface FirstRunStore {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

export function openOnFirstRun(store: FirstRunStore, reveal: () => Promise<void>): boolean {
  if (store.load(FIRST_RUN_KEY) === true) return false;
  store.save(FIRST_RUN_KEY, true);
  void reveal().catch(() => undefined);
  return true;
}
