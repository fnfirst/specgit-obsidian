import { clientId, normalizeServer, redirectUri } from "./config";

export function authorizeUrl(server: string, params: { challenge: string; state: string; vaultName: string; installId?: string; github?: "install" }): string {
  const url = new URL(`${normalizeServer(server)}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId(server));
  url.searchParams.set("redirect_uri", redirectUri(server));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("vault", params.vaultName);
  if (params.installId) url.searchParams.set("install", params.installId);

  if (params.github) url.searchParams.set("github", params.github);
  return url.toString();
}

export type AuthLink =

  | { kind: "session"; session: string; state: string }

  | { kind: "declined"; state: string }

  | { kind: "invalid" };

export function parseAuthLink(params: Readonly<Record<string, string>>): AuthLink {
  const state = params.state;
  if (typeof state !== "string" || state === "") return { kind: "invalid" };
  if (params.error === "access_denied") return { kind: "declined", state };
  const session = params.session;
  if (params.error || typeof session !== "string" || session === "") return { kind: "invalid" };
  return { kind: "session", session, state };
}
