export const DEFAULT_SERVER = "https://specgit.com";

export const AUTH_ACTION = "specgit-auth";

export const VERSION_HEADER = "X-Specgit-Obsidian-Version";

export const PLUGIN_OUTDATED_CODE = "plugin_outdated";

export const GIT_PROVIDER = "github-app";

export const NOTE_BRANCH = "main";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isServerAddress(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.hostname !== "";
    if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    return false;
  } catch {
    return false;
  }
}

export function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

export function isDefaultServer(server: string): boolean {
  try {
    const url = new URL(server.trim());
    return url.origin === DEFAULT_SERVER && (url.pathname === "" || url.pathname === "/");
  } catch {
    return normalizeServer(server).toLowerCase() === DEFAULT_SERVER;
  }
}

export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return normalizeServer(server);
  }
}

export function clientId(server: string): string {
  return `${normalizeServer(server)}/oauth/clients/obsidian.json`;
}

export function redirectUri(server: string): string {
  return `${normalizeServer(server)}/oauth/obsidian/return`;
}
