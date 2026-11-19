export const DEFAULT_SERVER = "https://specgit.com";

export const AUTH_ACTION = "specgit-auth";

export const VERSION_HEADER = "X-Specgit-Obsidian-Version";

export const PLUGIN_OUTDATED_CODE = "plugin_outdated";

export const GIT_PROVIDER = "github-app";

export const NOTE_BRANCH = "main";

export function isServerAddress(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

export function clientId(server: string): string {
  return `${normalizeServer(server)}/oauth/clients/obsidian.json`;
}

export function redirectUri(server: string): string {
  return `${normalizeServer(server)}/oauth/obsidian/return`;
}
