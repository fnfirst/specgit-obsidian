export type AuthErrorCode =
  | "signed_out"
  | "network"
  | "rejected"
  | "declined"
  | "plugin_outdated"
  | "room_ended"
  | "document_deleted"
  | "unexpected";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export const SIGNED_OUT_MESSAGE = "You're signed out of specgit. Choose Sign in to continue.";
export const NETWORK_MESSAGE = "specgit didn't answer. Check your connection and try again.";
export const ROOM_ENDED_MESSAGE = "This note's live session ended. Open the note again to rejoin.";
export const REJECTED_MESSAGE = "That sign-in didn't work. It may have expired or been used already. Choose Sign in to start again.";
export const NO_SIGN_IN_MESSAGE = "No sign-in is waiting in this vault. Choose Sign in to start one.";
