export const MARKDOWN_ROOT = "markdown";

export const MARKDOWN_META_ROOT = "markdown:meta";

export const CAUGHT_UP_KEY = "caughtUp";

export const SEED_CLAIM_KEY = "seedClaim";

export function sessionSeedClaim(doc: { getMap(name: string): { get(key: string): unknown } }): string | null {
  const claim = doc.getMap(MARKDOWN_META_ROOT).get(SEED_CLAIM_KEY);

  return typeof claim === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(claim) ? claim : null;
}

export const BRIDGE_FIELD = "bridge";

export const TREE_ROOT = "default";

export const CURSOR_FIELD = "cursor";

export { ACTOR_FIELD, LOGIN_FIELD, OBSIDIAN_ACTOR } from "./shared/review-flow";

export const ROOM_DIVERGED_MESSAGE = "room_diverged";

export const ROOM_TOO_LARGE = "room_too_large";

export const ROOM_ENDED_REASON = "room_ended";
