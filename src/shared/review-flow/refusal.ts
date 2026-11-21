import { CHECKS_WAIT } from "./publish-policy";

export type RefusalKind = "method" | "restricted" | "retry" | "checks" | "other";

export function classifyRefusal(err: { message?: string; code?: string }, pr?: { mergeableState?: string | null; mergeable?: boolean | null }): RefusalKind {
  const message = (err.message ?? "").toLowerCase();
  if (/squash|merge method|rebase merge|merge commits? (are|is) not allowed|merging is not allowed/.test(message)) return "method";
  if (/required (status )?checks?|status checks? (is|are) (expected|required|pending|failing)|checks? (is|are) (expected|required|pending|failing)/.test(message)) return "checks";
  if (err.code === "forbidden" || /restrict|not authorized|permission|may not push|cannot push/.test(message)) return "restricted";
  if (/base branch was modified|head branch was modified/.test(message)) return "retry";
  if (/not mergeable/.test(message) && (pr?.mergeableState === "unknown" || pr?.mergeable === null)) return "retry";
  return "other";
}

export function refusalWords(kind: RefusalKind, branch: string, hostWords?: string): string {
  switch (kind) {
    case "method":
      return "This repository's settings on GitHub don't allow the kind of merge specgit publishes with, so nothing was changed. Ask someone who manages the repository to turn on 'Allow squash merging', then try again.";
    case "restricted":
      return `GitHub doesn't let you publish to ${branch} in this repository, so nothing was changed. Ask someone who can publish there, or ask a repository admin to give you access.`;
    case "checks":
      return CHECKS_WAIT;
    case "retry":
      return "GitHub wasn't ready to publish this just now, so nothing was changed. Try again in a moment.";
    case "other":
      return hostWords ? `Nothing was changed. GitHub said: ${hostWords}` : "Nothing was changed. GitHub didn't say why, so check the pull request on GitHub.";
  }
}
