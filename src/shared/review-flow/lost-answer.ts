export const LOST_ANSWER_TITLE = "We're not sure that worked";
export const LOST_ANSWER_DESCRIPTION = "specgit didn't answer, so we can't tell yet. We're checking now.";

export const LOST_ANSWER_WORDS = { title: LOST_ANSWER_TITLE, description: LOST_ANSWER_DESCRIPTION } as const;

const LOST_NAMES = new Set(["AbortError", "TimeoutError", "NetworkError"]);

const NETWORK_WORDS = /failed to fetch|networkerror|load failed|fetch failed|network (error|request failed|connection)|connection (reset|closed|lost)|terminated|ERR_[A-Z_]+/i;

export function isLostAnswer(err: unknown): boolean {
  const named = err as { name?: unknown; message?: unknown } | null | undefined;
  if (typeof named?.name !== "string") return false;
  if (LOST_NAMES.has(named.name)) return true;
  return named.name === "TypeError" && typeof named.message === "string" && NETWORK_WORDS.test(named.message);
}
