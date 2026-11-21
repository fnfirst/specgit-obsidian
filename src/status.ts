import { Board } from "./board";
import type { Here } from "./presence";

export type NotePhase = "local" | "joining" | "live" | "offline" | "blocked" | "locked";

export interface NoteStatus {
  phase: NotePhase;
  online: boolean;
  readOnly: boolean;
  others: number;
  here?: Here[];
  alsoIn?: string;
  why?: "read-only" | "revoked" | "unreachable" | "deleted";
  retryAt?: number;
}

export const isNotLive = (phase: NotePhase): boolean => phase === "offline" || phase === "blocked" || phase === "locked";

export const phaseOf = (status: NoteStatus | null | undefined): NotePhase => status?.phase ?? "local";

export type NoteWord = "Local" | "Connecting…" | "Live" | "Reconnecting…" | "Not live";

export function wordFor({ phase, online }: NoteStatus): NoteWord {
  switch (phase) {
    case "local":
      return "Local";
    case "joining":
      return "Connecting…";
    case "live":
      return online ? "Live" : "Reconnecting…";
    case "offline":
    case "blocked":
    case "locked":
      return "Not live";
  }
}

export const NOT_CONNECTED = "Couldn't connect this note just now. Try again in a moment.";

export function joinFailedWords(problem: string): string {
  const reason = problem.trim().replace(/\.$/, "");
  return /try again/i.test(reason) ? `Couldn't connect this note live: ${reason}.` : `Couldn't connect this note live: ${reason}. Try again in a moment.`;
}

export function statusText(status: NoteStatus | undefined): string {
  if (!status) return "";
  const word = wordFor(status);
  return word === "Live" && status.readOnly ? "Live, read-only" : word;
}

export function statusTip(status: { phase: NotePhase; online?: boolean; readOnly?: boolean; why?: NoteStatus["why"] }): string {
  switch (status.phase) {
    case "local":
      return "specgit: this note is Local. Your edits stay in this vault until you connect it.";
    case "joining":
      return "specgit: connecting this note for live editing.";
    case "live":
      if (status.online === false) return "specgit: connection lost. Your edits are kept and shared when it's back.";
      return status.readOnly === true ? "specgit: this note is live. You can read it as others type, but not change it." : "specgit: this note is live. Everyone editing it sees your changes as you type.";
    case "offline":
    case "blocked":
      return "specgit: this note isn't live just now. Your edits stay in this vault.";
    case "locked":
      if (status.why === "deleted") return "specgit: this note was deleted on specgit.com, so it can't be edited here.";
      return "specgit: this note is read-only and isn't live. Click Disconnect, then Connect Live to fix it.";
  }
}

export class StatusBoard extends Board<NoteStatus> {
  private readonly told = new Set<string>();

  markTold(path: string): void {
    this.told.add(path);
  }

  wasTold(path: string): boolean {
    return this.told.delete(path);
  }

  phaseOf(path: string): NotePhase {
    return phaseOf(this.get(path));
  }
}
