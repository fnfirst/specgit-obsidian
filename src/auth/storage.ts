import { hashText } from "../hash";
import { DEFAULT_SERVER, normalizeServer } from "./config";

export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  deleteSecret?(id: string): void;
}

export interface SignInKeeping {

  kept(): boolean;
  keep(on: boolean): void;
}

export interface AuthStorageOptions {

  canEncrypt?: () => boolean;

  keepChoice?: { read(): boolean; write(on: boolean): void };

  moved?: () => void;
}

export interface PendingSignIn {
  verifier: string;
  state: string;
  startedAt: number;
}

export const PENDING_TTL_MS = 30 * 60_000;

export function secretId(kind: "refresh" | "server" | "pending", vaultName: string): string {
  const slug = vaultName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
  return `specgit-${kind}-${slug || "vault"}-${hashText(vaultName)}`;
}

function deleteSecretOf(secrets: SecretStore, id: string): boolean {
  const remove = (secrets as { deleteSecret?: unknown }).deleteSecret;
  if (typeof remove !== "function") return false;
  try {
    (remove as (id: string) => unknown).call(secrets, id);
    return true;
  } catch {
    return false;
  }
}

export class AuthStorage {
  private readonly refreshId: string;
  private readonly serverId: string;
  private readonly pendingId: string;
  private readonly server: string;

  private memory: string | null = null;

  private pendingMemory: string | null = null;

  constructor(
    private readonly secrets: SecretStore,
    vaultName: string,
    server: string = DEFAULT_SERVER,
    private readonly options: AuthStorageOptions = {},
  ) {
    this.refreshId = secretId("refresh", vaultName);
    this.serverId = secretId("server", vaultName);
    this.pendingId = secretId("pending", vaultName);
    this.server = normalizeServer(server);
  }

  keptOnDisk(): boolean {
    return this.onDisk();
  }

  private onDisk(): boolean {
    return (this.options.canEncrypt?.() ?? true) || (this.options.keepChoice?.read() ?? false);
  }

  private storedToken(): string | null {
    return this.secrets.getSecret(this.serverId) === this.server ? this.secrets.getSecret(this.refreshId) || null : null;
  }

  private storeToken(token: string): void {
    this.secrets.setSecret(this.serverId, this.server);
    this.secrets.setSecret(this.refreshId, token);
  }

  private settle(announce = true): void {
    if (this.onDisk()) {
      if (this.memory !== null) {
        this.storeToken(this.memory);
        this.memory = null;
      }
      if (this.pendingMemory !== null) {
        this.secrets.setSecret(this.pendingId, this.pendingMemory);
        this.pendingMemory = null;
      }
      return;
    }
    const stored = this.storedToken();
    const waiting = this.secrets.getSecret(this.pendingId);
    if (waiting) this.pendingMemory ??= waiting;
    for (const id of [this.refreshId, this.serverId, this.pendingId]) this.removeSecret(id);
    if (stored === null) return;
    this.memory ??= stored;
    if (announce) this.options.moved?.();
  }

  refreshToken(): string | null {
    this.settle();
    return this.onDisk() ? this.storedToken() : this.memory;
  }

  setRefreshToken(token: string): void {
    this.settle();
    if (this.onDisk()) this.storeToken(token);
    else this.memory = token;
  }

  clearRefreshToken(): void {
    this.memory = null;
    this.clearSecret(this.refreshId);
  }

  keeping(): SignInKeeping | null {
    const choice = this.options.keepChoice;
    if ((this.options.canEncrypt?.() ?? true) || !choice) return null;
    return {
      kept: () => choice.read(),
      keep: (on) => {
        choice.write(on);
        this.settle(false);
      },
    };
  }

  pending(now: number): PendingSignIn | null {
    const found = this.stored();
    return found !== null && now - found.startedAt <= PENDING_TTL_MS ? found : null;
  }

  expired(now: number): PendingSignIn | null {
    const found = this.stored();
    return found !== null && now - found.startedAt > PENDING_TTL_MS ? found : null;
  }

  private stored(): PendingSignIn | null {
    this.settle();
    const stored = this.onDisk() ? this.secrets.getSecret(this.pendingId) : this.pendingMemory;
    if (!stored) return null;
    try {
      const found = JSON.parse(stored) as Partial<PendingSignIn>;
      if (typeof found.verifier !== "string" || typeof found.state !== "string" || typeof found.startedAt !== "number") return null;
      return { verifier: found.verifier, state: found.state, startedAt: found.startedAt };
    } catch {
      return null;
    }
  }

  setPending(pending: PendingSignIn): void {
    this.settle();
    if (this.onDisk()) this.secrets.setSecret(this.pendingId, JSON.stringify(pending));
    else this.pendingMemory = JSON.stringify(pending);
  }

  clearPending(): void {
    this.pendingMemory = null;
    this.clearSecret(this.pendingId);
  }

  private clearSecret(id: string): void {
    if (this.onDisk()) this.secrets.setSecret(id, "");
    else this.removeSecret(id);
  }

  private removeSecret(id: string): void {
    const value = this.secrets.getSecret(id);
    if (value === null || value === undefined) return;
    if (deleteSecretOf(this.secrets, id)) return;
    if (value !== "") this.secrets.setSecret(id, "");
  }
}
