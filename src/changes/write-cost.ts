import { WRITES_PER_FILE } from "./burst";
import { RECORD_WRITES } from "../shared/review-flow";

export const MOVES_WRITES = 9;

export function writeCost(method: string, args: readonly unknown[]): number {
  switch (method) {
    case "save": {
      const options = (args[3] ?? {}) as { toExistingReview?: boolean; hasReview?: boolean };
      return options.toExistingReview || options.hasReview ? 1 : WRITES_PER_FILE;
    }
    case "rename":
      return WRITES_PER_FILE;
    case "attachment":
    case "uploadAttachment":
      return 1;
    case "moves":
      return ((args[1] as { moves?: unknown[] } | undefined)?.moves?.length ?? 0) > 0 ? MOVES_WRITES : 1;
    case "group": {
      const action = args[1];
      if (action === "create") return WRITES_PER_FILE;
      if (action === "burst") return 1 + RECORD_WRITES + ((args[2] as { upload?: { last?: boolean } } | undefined)?.upload?.last ? 1 + RECORD_WRITES + 1 : 0);
      return 0;
    }
    default:
      return 0;
  }
}
