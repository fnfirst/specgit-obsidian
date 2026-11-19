export function hasSuggestionBody(body: string): boolean {
  return /```suggestion/.test(body);
}

export function extractSuggestionReplacement(body: string): string | null {
  const match = /```suggestion\r?\n([\s\S]*?)```/.exec(body);
  if (!match) return null;

  return match[1]!.replace(/\r?\n$/, "");
}

export function extractSuggestionFromComments(
  comments: ReadonlyArray<{ body: string }>,
): string | null {
  for (const comment of comments) {
    const replacement = extractSuggestionReplacement(comment.body);
    if (replacement !== null) return replacement;
  }
  return null;
}
