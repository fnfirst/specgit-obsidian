import { signInConfirmPhrase } from "../shared/review-flow";
import { retryAfterFromResponse } from "../api/retry-after";
import { clientId, normalizeServer, redirectUri, VERSION_HEADER } from "./config";
import { AuthError, NETWORK_MESSAGE, NO_SIGN_IN_MESSAGE, REJECTED_MESSAGE, SIGNED_OUT_MESSAGE } from "./errors";
import { authorizeUrl, parseAuthLink, type AuthLink } from "./link";
import { createPkce, randomToken, type Pkce } from "./pkce";
import type { AuthStorage, SignInKeeping } from "./storage";
import { formBody, jsonObject, type Transport } from "./transport";

export const REFRESH_MARGIN_MS = 60_000;
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);
const MAX_TOKEN_RETRY_AFTER_MS = 60 * 60_000;

export type AuthEvent =
  | { kind: "started" }
  | { kind: "signed_in"; over: boolean }
  | { kind: "signed_out"; reason: "chosen" | "refused" }
  | { kind: "declined" }
  | { kind: "failed"; error: AuthError };

export interface Profile {
  login: string;
  name: string;
  avatarUrl: string;
}

export interface AuthOptions {
  server: string;
  version: string;
  vaultName: string;
  installId?: string;
  storage: AuthStorage;
  transport: Transport;
  openBrowser: (url: string) => void;
  defer?: (work: () => void) => void;
  now?: () => number;
  pkce?: () => Promise<Pkce>;
  newState?: () => string;
}

interface AccessToken {
  token: string;
  expiresAt: number;
}

export class SpecgitAuth {
  private readonly server: string;
  private readonly defer: (work: () => void) => void;
  private readonly now: () => number;
  private readonly pkce: () => Promise<Pkce>;
  private readonly newState: () => string;
  private readonly listeners = new Set<(event: AuthEvent) => void>();
  private access: AccessToken | null = null;
  private renewing: Promise<string> | null = null;
  private signIns = 0;
  private claimed: string | null = null;
  private lastAddress: string | null = null;
  private trading = 0;
  private refusedDuringTrade: string | null = null;
  private rateLimitedUntil = 0;

  constructor(private readonly options: AuthOptions) {
    this.server = normalizeServer(options.server);
    this.defer = options.defer ?? ((work) => void window.setTimeout(work, 0));
    this.now = options.now ?? (() => Date.now());
    this.pkce = options.pkce ?? createPkce;
    this.newState = options.newState ?? (() => randomToken(16));
  }

  isWaiting(): boolean {
    return this.options.storage.pending(this.now()) !== null;
  }

  confirmPhrase(): string | null {
    const state = this.options.storage.pending(this.now())?.state;
    return state ? signInConfirmPhrase(state) : null;
  }

  keeping(): SignInKeeping | null {
    return this.options.storage.keeping();
  }

  isSignedIn(): boolean {
    return this.options.storage.refreshToken() !== null;
  }

  onChange(listener: (event: AuthEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(event: AuthEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("specgit: a listener of the sign-in failed", error);
      }
    }
  }

  async signIn(options: { install?: boolean } = {}): Promise<void> {
    const { verifier, challenge } = await this.pkce();
    const state = this.newState();
    this.claimed = null;
    this.options.storage.setPending({ verifier, state, startedAt: this.now() });
    this.lastAddress = authorizeUrl(this.server, { challenge, state, vaultName: this.options.vaultName, ...(this.options.installId ? { installId: this.options.installId } : {}), ...(options.install === true ? { github: "install" as const } : {}) });
    this.options.openBrowser(this.lastAddress);
    this.emit({ kind: "started" });
  }

  reopenBrowser(): boolean {
    if (this.lastAddress === null || this.options.storage.pending(this.now()) === null) return false;
    this.options.openBrowser(this.lastAddress);
    return true;
  }

  handleLink(params: Readonly<Record<string, string>>): void {
    const link = parseAuthLink(params);
    if (link.kind !== "invalid" && link.state === this.claimed) return;
    const pending = this.options.storage.pending(this.now());
    if (link.kind === "invalid" || pending === null || pending.state !== link.state) {
      const tooLong = link.kind !== "invalid" && pending === null && this.options.storage.expired(this.now())?.state === link.state;
      this.emit({
        kind: "failed",
        error: new AuthError("rejected", tooLong ? "This sign-in took too long. Choose Sign in to start again." : "That sign-in link wasn't started in this vault. Sign in here instead."),
      });
      return;
    }
    this.claimed = link.state;
    this.defer(() => void this.finishLink(link));
  }

  private async finishLink(link: Exclude<AuthLink, { kind: "invalid" }>): Promise<void> {
    if (link.kind === "declined") {
      this.options.storage.clearPending();
      this.emit({ kind: "declined" });
      return;
    }
    try {
      await this.trade(link.session, link.state);
    } catch (error) {
      this.emit({ kind: "failed", error: error instanceof AuthError ? error : new AuthError("unexpected", REJECTED_MESSAGE) });
    }
  }

  async completeWithCode(code: string): Promise<void> {
    const session = code.trim();
    if (session === "") throw new AuthError("rejected", "Paste the code from specgit.com.");
    const pending = this.options.storage.pending(this.now());
    if (pending === null) throw new AuthError("rejected", NO_SIGN_IN_MESSAGE);
    if (pending.state === this.claimed) return;
    this.claimed = pending.state;
    await this.trade(session, pending.state);
  }

  private headers(): Record<string, string> {
    return { [VERSION_HEADER]: this.options.version };
  }

  private async tokenRequest(fields: Record<string, string>): Promise<{ ok: true; access: AccessToken; refresh: string } | { ok: false; status: number; error: string | null }> {
    let response;
    try {
      response = await this.options.transport({
        url: `${this.server}/oauth/token`,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        headers: this.headers(),
        body: formBody({ client_id: clientId(this.server), ...fields }),
      });
    } catch {
      throw new AuthError("network", NETWORK_MESSAGE);
    }
    const body = jsonObject(response.text);
    const access = body?.access_token;
    const refresh = body?.refresh_token;
    const lifetime = body?.expires_in;
    if (response.status === 200 && typeof access === "string" && typeof refresh === "string" && typeof lifetime === "number") {
      this.rateLimitedUntil = 0;
      return { ok: true, access: { token: access, expiresAt: this.now() + lifetime * 1000 }, refresh };
    }
    if (response.status === 429) {
      const retryAfterMs = retryAfterFromResponse(response.headers, body, this.now(), MAX_TOKEN_RETRY_AFTER_MS);
      const error = new AuthError("network", NETWORK_MESSAGE, 429);
      if (retryAfterMs !== undefined) {
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.now() + retryAfterMs);
        Object.assign(error, { retryAfterMs });
      }
      throw error;
    }
    if (response.status >= 500) throw new AuthError("network", NETWORK_MESSAGE, response.status);
    if (response.status === 200) throw new AuthError("unexpected", "specgit answered in a way the plugin doesn't understand. Update specgit in Obsidian's Community plugins and try again.", 200);
    return { ok: false, status: response.status, error: typeof body?.error === "string" ? body.error : null };
  }

  private async trade(session: string, state: string): Promise<void> {
    const pending = this.options.storage.pending(this.now());
    if (pending === null || pending.state !== state) {
      this.claimed = null;
      throw new AuthError("rejected", NO_SIGN_IN_MESSAGE);
    }
    let over = false;
    this.trading++;
    try {
      const result = await this.tokenRequest({ grant_type: "authorization_code", code: session, redirect_uri: redirectUri(this.server), code_verifier: pending.verifier });
      if (!result.ok) {
        this.options.storage.clearPending();
        throw new AuthError("rejected", REJECTED_MESSAGE, result.status);
      }
      over = this.access !== null || this.isSignedIn();
      this.access = result.access;
      this.rateLimitedUntil = 0;
      this.refusedDuringTrade = null;
      this.options.storage.setRefreshToken(result.refresh);
      this.options.storage.clearPending();
    } catch (error) {
      if (this.options.storage.pending(this.now())?.state === state) this.claimed = null;
      throw error;
    } finally {
      this.trading--;
      if (this.trading === 0 && this.refusedDuringTrade !== null) {
        const refused = this.refusedDuringTrade;
        this.refusedDuringTrade = null;
        if (this.options.storage.refreshToken() === refused) {
          this.signIns++;
          this.access = null;
          this.rateLimitedUntil = 0;
          this.options.storage.clearRefreshToken();
          this.emit({ kind: "signed_out", reason: "refused" });
        }
      }
    }
    this.signIns++;
    this.emit({ kind: "signed_in", over });
  }

  get signInId(): number {
    return this.signIns;
  }

  accessToken(): Promise<string> {
    if (this.access !== null && this.access.expiresAt - this.now() > REFRESH_MARGIN_MS) return Promise.resolve(this.access.token);
    return this.renew();
  }

  async login(): Promise<string | null> {
    return (await this.profile())?.login ?? null;
  }

  async profile(): Promise<Profile | null> {
    const signIn = this.signIns;
    try {
      const response = await this.options.transport({
        url: `${this.server}/api/auth/session`,
        method: "GET",
        headers: { Authorization: `Bearer ${await this.accessToken()}`, ...this.headers() },
      });
      const answer = jsonObject(response.text);
      const connections = answer?.connections;
      const first: unknown = Array.isArray(connections) ? connections[0] : undefined;
      const login = typeof first === "object" && first !== null ? (first as Record<string, unknown>).login : undefined;
      if (response.status !== 200 || typeof login !== "string" || login === "") return null;
      const user = typeof answer?.user === "object" && answer.user !== null ? (answer.user as Record<string, unknown>) : {};
      const said = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
      if (this.signIns !== signIn) return null;
      return { login, name: said(user.displayName), avatarUrl: said(user.avatarUrl) };
    } catch {
      return null;
    }
  }

  renew(): Promise<string> {
    this.renewing ??= this.refresh().finally(() => void (this.renewing = null));
    return this.renewing;
  }

  private async refresh(): Promise<string> {
    const refreshToken = this.options.storage.refreshToken();
    if (refreshToken === null) throw new AuthError("signed_out", SIGNED_OUT_MESSAGE);
    const remaining = this.rateLimitedUntil - this.now();
    if (remaining > 0) {
      const error = new AuthError("network", NETWORK_MESSAGE, 429);
      Object.assign(error, { retryAfterMs: remaining });
      throw error;
    }
    const result = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (this.options.storage.refreshToken() !== refreshToken) throw new AuthError("signed_out", SIGNED_OUT_MESSAGE);
    if (!result.ok) {
      const permanent = result.status === 401 || result.status === 403 || (result.error !== null && PERMANENT_REFUSALS.has(result.error));
      if (permanent) {
        if (this.trading > 0) {
          this.refusedDuringTrade = refreshToken;
          throw new AuthError("signed_out", SIGNED_OUT_MESSAGE, result.status);
        }
        this.forget();
        this.emit({ kind: "signed_out", reason: "refused" });
        throw new AuthError("signed_out", SIGNED_OUT_MESSAGE, result.status);
      }
      throw new AuthError("unexpected", "specgit didn't accept the plugin's request. Update specgit in Obsidian's Community plugins and try again.", result.status);
    }
    this.options.storage.setRefreshToken(result.refresh);
    this.access = result.access;
    return result.access.token;
  }

  private forget(): void {
    this.signIns++;
    this.access = null;
    this.refusedDuringTrade = null;
    this.rateLimitedUntil = 0;
    this.options.storage.clearRefreshToken();
    this.options.storage.clearPending();
  }

  async signOut(): Promise<void> {
    const refreshToken = this.options.storage.refreshToken();
    this.forget();
    this.emit({ kind: "signed_out", reason: "chosen" });
    await this.revoke(refreshToken);
  }

  async endUnkept(): Promise<void> {
    if (this.options.storage.keptOnDisk()) return;
    const refreshToken = this.options.storage.refreshToken();
    if (refreshToken === null) return;
    this.access = null;
    this.options.storage.clearRefreshToken();
    await this.revoke(refreshToken);
  }

  private async revoke(refreshToken: string | null): Promise<void> {
    if (refreshToken === null) return;
    try {
      await this.options.transport({
        url: `${this.server}/oauth/revoke`,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        headers: this.headers(),
        body: formBody({ token: refreshToken, client_id: clientId(this.server) }),
      });
    } catch {
      void 0;
    }
  }
}
