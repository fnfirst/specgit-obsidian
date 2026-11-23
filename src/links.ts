import { GIT_PROVIDER, isLoopbackHost, NOTE_BRANCH, normalizeServer } from "./auth/config";
import type { DocumentRef } from "./mapping";

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseLoopbackHttpServer(server: string | undefined): URL | null {
  if (typeof server !== "string" || hasControlChars(server)) return null;
  const trimmed = server.trim();
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname) && parsed.username === "" && parsed.password === "") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function safeExternalUrl(raw: string, server?: string): string | null {
  if (typeof raw !== "string" || hasControlChars(raw)) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url.hostname !== "" ? url.href : null;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    const configured = parseLoopbackHttpServer(server);
    if (configured !== null && url.origin === configured.origin) return url.href;
  }
  return null;
}

export function openExternalUrl(raw: string, server?: string): boolean {
  const safe = safeExternalUrl(raw, server);
  if (safe === null) return false;
  window.open(safe);
  return true;
}

export function safeRealtimeUrl(raw: string, server: string): string | null {
  if (typeof raw !== "string" || hasControlChars(raw)) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "wss:") return url.hostname !== "" ? url.href : null;
  if (url.protocol === "ws:" && isLoopbackHost(url.hostname) && parseLoopbackHttpServer(server) !== null) return url.href;
  return null;
}

export function noteUrl(server: string, doc: DocumentRef): string {
  const [owner = "", repo = ""] = doc.repo.split("/");
  const query = new URLSearchParams({ provider: GIT_PROVIDER, owner, repo, branch: NOTE_BRANCH, path: doc.path });
  return `${normalizeServer(server)}/doc?${query.toString()}`;
}

export function giveAccessUrl(server: string, repo: string, ownerInstallationId: number | null = null): string {
  if (ownerInstallationId !== null) return `https://github.com/settings/installations/${ownerInstallationId}`;
  return `${normalizeServer(server)}/api/auth/app/install?returnTo=${encodeURIComponent(`/repos/${GIT_PROVIDER}/${repo}`)}`;
}
