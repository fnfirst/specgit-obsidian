import { type App, Notice, type Plugin } from "obsidian";
import { openExternalUrl } from "../links";
import { randomToken } from "./pkce";
import type { DocumentRef } from "../mapping";
import type { AskedStep } from "../token-source";
import { AUTH_ACTION, DEFAULT_SERVER, isDefaultServer, serverHost } from "./config";
import { SpecgitBinaryFetch } from "./binary-fetch";
import { SIGNED_OUT_MESSAGE } from "./errors";
import { SpecgitGitCopy } from "./git-copy";
import { obsidianTransport } from "./obsidian-transport";
import { PasteCodeModal } from "./paste-modal";
import { SpecgitRoomPeople } from "./room-people";
import { SpecgitAuth, type AuthEvent } from "./session";
import { AuthStorage } from "./storage";
import { SpecgitTokenSource } from "./token-source";

export interface AuthSetup {
  auth: SpecgitAuth;
  tokens: SpecgitTokenSource;
  gitCopy: SpecgitGitCopy;
  roomPeople: SpecgitRoomPeople;
  binary: SpecgitBinaryFetch;
  signIn: (options?: { install?: boolean }) => Promise<void>;
}

export interface AuthSetupOptions {
  server?: string;
  notify?: (message: string) => void;
  notifyUntilDismissed?: (message: string) => void;
  pendingSteps?: (doc: DocumentRef) => readonly AskedStep[];
  confirmServer?: (host: string) => Promise<boolean>;
}

export const SIGN_IN_NOT_KEPT_NOTICE =
  "You'll sign in each time Obsidian opens. To stay signed in, turn on Keep me signed in on this computer in settings.";

const INSTALL_ID_KEY = "specgit-install-id";

export function installationId(app: Pick<App, "loadLocalStorage" | "saveLocalStorage">): string {
  const kept: unknown = app.loadLocalStorage(INSTALL_ID_KEY);
  if (typeof kept === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(kept)) return kept;
  const made = randomToken(24);
  app.saveLocalStorage(INSTALL_ID_KEY, made);
  return made;
}

const KEEP_SIGNED_IN_KEY = "specgit-keep-signed-in";

export function canEncryptSecrets(secrets: unknown): boolean {
  const check = (secrets as { isEncryptionAvailable?: unknown } | null)?.isEncryptionAvailable;
  if (typeof check !== "function") return true;
  try {
    return (check as () => unknown).call(secrets) !== false;
  } catch {
    return true;
  }
}

export function setUpAuth(plugin: Plugin, options: AuthSetupOptions = {}): AuthSetup {
  const server = options.server ?? DEFAULT_SERVER;
  const notify = options.notify ?? ((message) => void new Notice(message));
  const notifyUntilDismissed = options.notifyUntilDismissed ?? ((message) => void new Notice(message, 0));
  const { app, manifest } = plugin;
  const vaultName = app.vault.getName();

  const auth = new SpecgitAuth({
    server,
    version: manifest.version,
    vaultName,
    installId: installationId(app),
    storage: new AuthStorage(app.secretStorage, vaultName, server, {
      canEncrypt: () => canEncryptSecrets(app.secretStorage),
      moved: () => notifyUntilDismissed(SIGN_IN_NOT_KEPT_NOTICE),
      keepChoice: {
        read: () => app.loadLocalStorage(KEEP_SIGNED_IN_KEY) === "1",
        write: (on) => app.saveLocalStorage(KEEP_SIGNED_IN_KEY, on ? "1" : null),
      },
    }),
    transport: obsidianTransport,
    openBrowser: (url) => void openExternalUrl(url, server),
  });
  const tokens = new SpecgitTokenSource({ server, version: manifest.version, auth, transport: obsidianTransport, ...(options.pendingSteps ? { pendingSteps: options.pendingSteps } : {}) });
  const binary = new SpecgitBinaryFetch({ server, version: manifest.version, auth });
  const gitCopy = new SpecgitGitCopy({ server, version: manifest.version, auth, transport: obsidianTransport, binaryFetch: binary });
  const roomPeople = new SpecgitRoomPeople({ server, version: manifest.version, auth, transport: obsidianTransport });

  let modal: PasteCodeModal | null = null;
  const closeModal = () => {
    modal?.close();
    modal = null;
  };

  const target = isDefaultServer(server) ? "specgit" : serverHost(server);

  const heard = (event: AuthEvent): void => {
    switch (event.kind) {
      case "signed_in":
        closeModal();
        notify(`Signed in to ${target}.`);
        break;
      case "declined":
        closeModal();
        notify("Sign-in cancelled. Choose Sign in to try again.");
        break;
      case "failed":
        if (!auth.isWaiting()) modal?.didntFinish();
        notify(event.error.message);
        break;
      case "signed_out":
        notify(event.reason === "chosen" ? `Signed out of ${target}.` : SIGNED_OUT_MESSAGE);
        break;
      case "started":
        break;
    }
  };
  plugin.register(auth.onChange(heard));
  plugin.register(() => void auth.endUnkept());

  plugin.registerObsidianProtocolHandler(AUTH_ACTION, (params) => auth.handleLink(params));

  const signIn = async (signInOptions: { install?: boolean } = {}): Promise<void> => {
    if (!isDefaultServer(server) && options.confirmServer && !(await options.confirmServer(serverHost(server)))) return;
    closeModal();
    await auth.signIn(signInOptions);
    const confirmPhrase = auth.confirmPhrase();
    modal = new PasteCodeModal(app, (code) => auth.completeWithCode(code), () => void auth.reopenBrowser(), {
      signInAgain: () => void signIn(),
      ...(confirmPhrase ? { confirmPhrase } : {}),
    });
    modal.open();
  };

  return { auth, tokens, gitCopy, roomPeople, binary, signIn };
}

export function addAuthCommands(plugin: Plugin, setup: Pick<AuthSetup, "auth" | "signIn">): void {
  plugin.addCommand({
    id: "sign-in",
    name: "Sign in",
    callback: () => void setup.signIn(),
  });
  plugin.addCommand({
    id: "sign-out",
    name: "Sign out",
    checkCallback: (checking) => {
      if (!setup.auth.isSignedIn()) return false;
      if (!checking) void setup.auth.signOut();
      return true;
    },
  });
}
