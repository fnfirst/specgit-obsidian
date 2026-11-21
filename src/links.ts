import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer } from "./auth/config";
import type { DocumentRef } from "./mapping";

export function noteUrl(server: string, doc: DocumentRef): string {
  const [owner = "", repo = ""] = doc.repo.split("/");
  const query = new URLSearchParams({ provider: GIT_PROVIDER, owner, repo, branch: NOTE_BRANCH, path: doc.path });
  return `${normalizeServer(server)}/doc?${query.toString()}`;
}

export function giveAccessUrl(server: string, repo: string, ownerInstallationId: number | null = null): string {
  if (ownerInstallationId !== null) return `https://github.com/settings/installations/${ownerInstallationId}`;
  return `${normalizeServer(server)}/api/auth/app/install?returnTo=${encodeURIComponent(`/repos/${GIT_PROVIDER}/${repo}`)}`;
}
