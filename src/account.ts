import type { Profile, SignInKeeping, SpecgitAuth } from "./auth";
import type { Account } from "./settings";

export interface AccountHost {
  config: { login: string; displayName: string; avatarUrl: string };
  saveConfig(): Promise<void>;
}

export const WHO_ASK_PATIENCE_MS = 30_000;

export class SpecgitAccount implements Account {
  private readonly loginListeners = new Set<() => void>();
  private readonly whoListeners = new Set<() => void>();

  private answeredFor: number | null = null;

  private asking: { signIn: number; at: number; done: Promise<void> } | null = null;

  constructor(
    private readonly auth: SpecgitAuth,

    readonly signIn: () => Promise<void>,
    private readonly host: AccountHost,
    private readonly now: () => number = Date.now,
  ) {}

  signedIn(): boolean {
    return this.auth.isSignedIn();
  }

  signOut(): Promise<void> {
    return this.auth.signOut();
  }

  keeping(): SignInKeeping | null {
    return this.auth.keeping();
  }

  onChange(listener: () => void): () => void {
    const stopAuth = this.auth.onChange(() => listener());
    this.loginListeners.add(listener);
    return () => {
      stopAuth();
      this.loginListeners.delete(listener);
    };
  }

  onWho(listener: () => void): () => void {
    this.whoListeners.add(listener);
    return () => void this.whoListeners.delete(listener);
  }

  owesWho(): boolean {
    return this.auth.isSignedIn() && this.answeredFor !== this.auth.signInId;
  }

  learnWhoIfOwed(): Promise<void> {
    return this.owesWho() ? this.learnWho() : Promise.resolve();
  }

  learnWho(): Promise<void> {
    const signIn = this.auth.signInId;
    const out = this.asking;
    const askIsOut = out !== null && out.signIn === signIn && this.now() - out.at < WHO_ASK_PATIENCE_MS;
    const askOnceMore = (): Promise<void> | undefined => (this.asking === null && this.owesWho() ? this.learnWho() : undefined);
    if (askIsOut) return out.done.then(askOnceMore);
    const done: Promise<void> = this.auth
      .profile()
      .then(async (profile) => {
        if (!profile) return;
        this.answeredFor = signIn;
        await this.setWho(profile);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.asking?.done === done) this.asking = null;
      });
    this.asking = { signIn, at: this.now(), done };
    return done;
  }

  async forgetLogin(): Promise<void> {
    await this.setWho({ login: "", name: "", avatarUrl: "" });
  }

  async beginSignIn(): Promise<void> {
    try {
      await this.setWho({ login: "", name: "", avatarUrl: "" });
    } finally {
      await this.learnWhoIfOwed();
    }
  }

  private async setWho({ login, name, avatarUrl }: Profile): Promise<void> {
    const { config } = this.host;
    const loginChanged = config.login !== login;
    if (!loginChanged && config.displayName === name && config.avatarUrl === avatarUrl) return;
    config.login = login;
    config.displayName = name;
    config.avatarUrl = avatarUrl;

    try {
      await this.host.saveConfig();
    } finally {
      if (loginChanged) for (const listener of [...this.loginListeners]) listener();
      for (const listener of [...this.whoListeners]) listener();
    }
  }
}
