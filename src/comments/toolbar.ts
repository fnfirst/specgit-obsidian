export const TOOLBAR_KEY = "specgit-mobile-toolbar-offer";

export interface ToolbarWorld {
  vault: { getConfig?: (key: string) => unknown; setConfig?: (key: string, value: unknown) => void };
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
}

const SETTING = "mobileToolbarCommands";

export interface ToolbarOffer {

  shown(): boolean;

  add(): boolean;

  dismiss(): void;
}

export function toolbarOffer(world: ToolbarWorld, commandId: string): ToolbarOffer {
  const { vault } = world;

  const listed = (): string[] | null => {
    if (typeof vault.getConfig !== "function" || typeof vault.setConfig !== "function") return null;
    try {
      const value = vault.getConfig(SETTING);
      return Array.isArray(value) && value.every((id): id is string => typeof id === "string") ? value : null;
    } catch {
      return null;
    }
  };
  return {
    shown() {
      if (world.loadLocalStorage(TOOLBAR_KEY) === true) return false;
      const commands = listed();
      return commands !== null && !commands.includes(commandId);
    },
    add() {
      const commands = listed();
      if (commands === null) return false;
      try {
        if (!commands.includes(commandId)) vault.setConfig?.(SETTING, [...commands, commandId]);
        return true;
      } catch {
        return false;
      }
    },
    dismiss() {
      world.saveLocalStorage(TOOLBAR_KEY, true);
    },
  };
}
