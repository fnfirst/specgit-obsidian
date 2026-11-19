import type { FlowDeps } from "./flow-deps";

export function isRoomed(deps: Pick<FlowDeps, "phaseOf" | "hasRoomBase">, path: string): boolean {
  return deps.phaseOf(path) !== "local" || deps.hasRoomBase(path);
}
