import type { NotePhase } from "../status";

export interface WritableWorld {
  phaseOf(path: string): NotePhase;
  hasUnsavedText(path: string): Promise<boolean>;
}

export type NotWritable = "live" | "typing";

export async function notWritableBecause(world: WritableWorld, path: string): Promise<NotWritable | null> {
  if (world.phaseOf(path) !== "local") return "live";
  return (await world.hasUnsavedText(path)) ? "typing" : null;
}
