import type { App } from "obsidian";

interface UndocumentedApp {
  vault: { getConfig?: (key: string) => unknown; setConfig?: (key: string, value: unknown) => void };
}

const undocumented = (app: App): UndocumentedApp => app as unknown as UndocumentedApp;

export type TrashOption = "system" | "local" | "none";

export function trashOption(app: App): TrashOption {
  const { vault } = undocumented(app);
  try {
    const value = vault.getConfig?.("trashOption");
    return value === "local" || value === "none" ? value : "system";
  } catch {
    return "system";
  }
}
