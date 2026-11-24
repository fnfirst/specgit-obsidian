export type SaverReason =
  | "no_writer"
  | "no_credential"
  | "no_access"
  | "plan_limit"
  | "behind"
  | "no_lineage"
  | "uncompared"
  | "ended"
  | "unavailable"
  | "unsupported";

export interface SaverWaiting {
  state: "waiting";
  reason: SaverReason | null;
  at: number;
  retryAt: number | null;
}

export interface SaverStatus {
  state: "saved" | "waiting";
  reason: SaverReason | null;
  at: number;
  retryAt: number | null;
}

export const SAVER_PAUSED_LABEL = "Saving paused";

export function saverWaitingLine(reason: string | null | undefined): string {
  switch (reason) {
    case "no_credential":
      return "Paused saving to GitHub. Reconnect GitHub to resume.";
    case "no_access":
      return "Paused saving to GitHub. Your account no longer has write access.";
    case "plan_limit":
      return "Paused saving to GitHub. This account reached its plan limit.";
    case "behind":
      return "Paused saving to GitHub. Catch up with newer changes first.";
    case "no_lineage":
    case "uncompared":
      return "Paused saving to GitHub. Reload this document to resync.";
    default:
      return "Paused saving to GitHub. Retrying automatically.";
  }
}
