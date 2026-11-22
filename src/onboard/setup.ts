import type { App, Plugin, TFile } from "obsidian";
import type { SpecgitApi } from "../api";
import type { SpecgitBinaryFetch } from "../auth/binary-fetch";
import type { AuthEvent } from "../auth/session";
import { MARK_ICON } from "../brand/mark";
import { gitBlobSha } from "../changes/blob-sha";
import { hashVaultBinary, readVaultBinaryBlob } from "../disk/vault-binary";
import { showNotice, showNoticeWithAction, showProgress } from "../notices";
import { VaultOnboarding } from "./flow";
import { OnboardWindow } from "./modal";
import { planVault } from "./plan";
import { UploadRecords } from "./record";
import { type UploadDeps, VaultUpload } from "./upload";
import { ONBOARD } from "./words";

export const ONBOARD_ACTION = "specgit-onboard";

export interface OnboardSetupDeps {
  api: SpecgitApi;
  binary?: Pick<SpecgitBinaryFetch, "uploadVaultPack">;
  signedIn: () => boolean;
  signIn: (options?: { install?: boolean }) => Promise<void>;
  isWaiting?: () => boolean;
  onAuth: (listener: (event: AuthEvent) => void) => () => void;
  apply: (mapping: { repo: string; folder: string }) => Promise<void>;
  repoChosen: () => boolean;
}

type Sized = { path: string; size: number };

function vaultReads(app: App): Pick<UploadDeps, "listed" | "config" | "ownGitignore" | "read" | "hashFile" | "readBlob" | "configDir"> {
  const { vault } = app;
  const { adapter, configDir } = vault;
  const isVaultFile = (path: string): boolean => !path.startsWith(`${configDir}/`) && path !== ".gitignore";
  const listConfig = async (dir: string, top: boolean): Promise<Sized[]> => {
    const { files, folders } = await adapter.list(dir);
    const here = await Promise.all(files.map(async (path): Promise<Sized> => ({ path, size: (await adapter.stat(path))?.size ?? 0 })));
    const below = await Promise.all(folders.filter((folder) => !top || /\/(themes|snippets)$/.test(folder)).map((folder) => listConfig(folder, false)));
    return [...here, ...below.flat()];
  };
  return {
    configDir,
    listed: () => vault.getFiles().map((file): Sized => ({ path: file.path, size: file.stat.size })),
    config: () => listConfig(configDir, true),
    ownGitignore: async () => ((await adapter.exists(".gitignore")) ? adapter.read(".gitignore") : null),
    read: async (path) => {
      const file: TFile | null = isVaultFile(path) ? vault.getFileByPath(path) : null;
      return new Uint8Array(file ? await vault.readBinary(file) : await adapter.readBinary(path));
    },
    hashFile: async (path, size) => (isVaultFile(path) ? hashVaultBinary(app, path, size) : gitBlobSha(await adapter.readBinary(path))),
    readBlob: async (path) => (isVaultFile(path) ? readVaultBinaryBlob(app, path) : new Uint8Array(await adapter.readBinary(path))),
  };
}

function onFront(listener: () => void): () => void {
  const visible = (): void => {
    if (activeDocument.visibilityState === "visible") listener();
  };
  window.addEventListener("focus", listener);
  activeDocument.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener("focus", listener);
    activeDocument.removeEventListener("visibilitychange", visible);
  };
}

export function setUpOnboard(plugin: Plugin, deps: OnboardSetupDeps): VaultOnboarding {
  const { app } = plugin;
  const reads = vaultReads(app);
  const wait = (ms: number): Promise<void> => new Promise((resume) => window.setTimeout(resume, ms));
  const call = (action: string, body: Record<string, unknown>) => deps.api.call("POST", "/api/vault-upload", { body: { action, ...body } });
  const onboarding = new VaultOnboarding({
    ui: new OnboardWindow(app),
    signedIn: deps.signedIn,
    signIn: (options) =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (outcome: "signed_in" | "unfinished"): void => {
          if (settled) return;
          settled = true;
          stop();
          resolve(outcome);
        };
        const stop = deps.onAuth((event) => {
          if (event.kind === "started") return;
          finish(event.kind === "signed_in" ? "signed_in" : "unfinished");
        });
        deps.signIn(options).then(
          () => {
            if (deps.isWaiting && !deps.isWaiting() && !deps.signedIn()) finish("unfinished");
          },
          () => finish("unfinished"),
        );
      }),
    call,
    plan: async () => planVault(reads.listed(), await reads.config(), reads.configDir, await reads.ownGitignore()),
    upload: (repo, control) =>
      new VaultUpload({
        ...reads,
        call,
        blobSha: gitBlobSha,
        ...(deps.binary ? { sendPack: (meta, blobs) => deps.binary!.uploadVaultPack(meta, blobs) } : {}),
        wait,
        now: Date.now,
        isCurrent: () => control.isCurrent(),
        progress: (state) => control.progress(state),
        ...(control.expectPrivate !== undefined ? { expectPrivate: control.expectPrivate } : {}),
      }).run(repo),
    record: new UploadRecords({ load: (key) => app.loadLocalStorage(key) as unknown, save: (key, value) => app.saveLocalStorage(key, value) }),
    openUrl: (url) => void window.open(url),
    onFront,
    wait,
    now: Date.now,
    apply: deps.apply,
    vaultName: () => app.vault.getName(),
    repoChosen: deps.repoChosen,
    notify: showNotice,
    notifyWithAction: (message, label, run) => void showNoticeWithAction(message, label, run),
    progressNotice: showProgress,
  });
  plugin.addCommand({
    id: "put-vault-on-github",
    name: ONBOARD,
    icon: MARK_ICON,
    checkCallback: (checking) => {
      if (deps.repoChosen()) return false;
      if (!checking) void onboarding.start();
      return true;
    },
  });
  plugin.registerObsidianProtocolHandler(ONBOARD_ACTION, () => onboarding.bringForward());
  plugin.register(() => onboarding.unload());
  app.workspace.onLayoutReady(() => onboarding.onLoad());
  return onboarding;
}
