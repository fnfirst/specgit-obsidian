import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";
import { drawLogo, TAGLINE } from "./brand/mark";
import { supportPageUrl } from "./report/report";
import { DEFAULT_SERVER, isServerAddress, normalizeServer } from "./auth/config";
import type { SignInKeeping } from "./auth/storage";
import { isRepoName, type MappingSettings } from "./mapping";
import { CHANGE, CHOOSE_A_REPOSITORY_FIRST, CHOOSE_REPOSITORY, NO_REPOSITORY_YET, outsideStays, WHOLE_VAULT } from "./pick/words";
import type { Identity } from "./presence";
import { SOMEONE } from "./shared/review-flow";
import type { StayDrafts } from "./stay/draft-state";
import { STAY, STAY_DRAFTS_WORDS } from "./stay/words";

export interface Settings extends MappingSettings {

  server: string;

  login: string;

  displayName: string;

  avatarUrl: string;

  color: string;

  stayConnected: boolean;

  stayOffered: boolean;

  stayDrafts: StayDrafts;
}

const DEVICE_KEYS: ReadonlySet<keyof Settings> = new Set<keyof Settings>(["stayConnected", "stayOffered"]);

export function withoutDeviceSettings(settings: Settings): Partial<Settings> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !DEVICE_KEYS.has(key as never)));
}

const DEVICE_KEY = "specgit-device-settings";

export class DeviceSettings {
  constructor(private readonly state: { load(key: string): unknown; save(key: string, value: unknown): void }) {}

  read(): Pick<Settings, "stayConnected" | "stayOffered"> {
    let stored: unknown = null;
    try {
      stored = this.state.load(DEVICE_KEY);
    } catch { /* empty */ }
    const given = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
    return { stayConnected: given.stayConnected === true, stayOffered: given.stayOffered === true };
  }

  write(settings: Pick<Settings, "stayConnected" | "stayOffered">): void {
    try {
      this.state.save(DEVICE_KEY, { stayConnected: settings.stayConnected, stayOffered: settings.stayOffered });
    } catch { /* empty */ }
  }
}

export const DEFAULT_SETTINGS: Settings = { repo: "", folder: "", server: DEFAULT_SERVER, login: "", displayName: "", avatarUrl: "", color: "", stayConnected: false, stayOffered: false, stayDrafts: "everyone" };

export function readSettings(stored: unknown): Settings {
  const given = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (DEVICE_KEYS.has(key)) continue;
    const value = given[key];
    if (typeof value === "string" && typeof DEFAULT_SETTINGS[key] === "string") (settings[key] as string) = value;
    else if (typeof value === "boolean" && typeof DEFAULT_SETTINGS[key] === "boolean") (settings[key] as boolean) = value;
  }

  settings.stayDrafts = given.stayDrafts === "mine" ? "mine" : "everyone";
  settings.server = isServerAddress(settings.server) ? normalizeServer(settings.server) : DEFAULT_SERVER;
  return settings;
}

export function identityFrom(settings: Settings): Identity {
  const login = settings.login.trim();
  return { name: settings.displayName.trim() || login || SOMEONE, login, color: settings.color.trim(), avatarUrl: settings.avatarUrl.trim() };
}

export interface Account {
  signedIn(): boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;

  onChange(listener: () => void): () => void;

  keeping?(): SignInKeeping | null;
}

export interface SettingsHost {
  config: Settings;
  saveConfig(): Promise<void>;

  setStayConnected(on: boolean): Promise<void>;

  linked?(): void;

  onSaved?(listener: () => void): () => void;
}

type TypedSetting = Exclude<{ [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings], "login" | "displayName" | "avatarUrl" | "stayDrafts">;

function accountText(signedIn: boolean, login: string): string {
  if (!signedIn) return "Not signed in. Sign in with GitHub to edit notes live.";
  return login ? `Signed in to specgit as @${login}.` : "Signed in to specgit.";
}

export const NOT_KEPT = "This computer can't store your sign-in securely, so you'll sign in each time you open Obsidian.";
export const KEPT_UNSECURED = "Your sign-in is kept on this computer, though it can't be stored securely here.";
export const KEEP_SIGNED_IN = "Keep me signed in on this computer";

export const TYPING_PAUSE_MS = 1_500;

export class SpecgitSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;
  private stopWatching: (() => void) | null = null;
  private stopWatchingSaves: (() => void) | null = null;

  private typing = 0;

  private flushers: Array<() => void> = [];

  private openedWith: string | null = null;

  constructor(
    app: App,
    plugin: Plugin & SettingsHost,
    private readonly account: Account,

    private readonly reportProblem: () => void = () => undefined,

    private readonly picker: { chooseRepository(): Promise<void>; chooseFolder(): Promise<void> } = { chooseRepository: () => Promise.resolve(), chooseFolder: () => Promise.resolve() },
  ) {
    super(app, plugin);
    this.host = plugin;
  }

  override display(): void {
    const { containerEl } = this;

    for (const flush of this.flushers) flush();
    containerEl.empty();
    this.flushers = [];
    this.openedWith ??= this.host.config.repo;

    this.stopWatching ??= this.account.onChange(() => this.display());

    this.stopWatchingSaves ??= this.host.onSaved?.(() => {
      if (this.typing === 0) this.display();
    }) ?? null;

    const text = (key: TypedSetting, setting: Setting, placeholder: string, normalize: (value: string) => string = (value) => value.trim(), onBlur = false): void => {
      setting.addText((input) => {
        let typed: string | null = null;
        let pause: number | undefined;
        const commit = (): void => {
          window.clearTimeout(pause);
          if (typed === null) return;
          this.host.config[key] = normalize(typed);
          typed = null;
          void this.saveTyped();
        };
        input
          .setPlaceholder(placeholder)
          .setValue(this.host.config[key])
          .onChange(async (value) => {
            if (!onBlur) {
              this.host.config[key] = normalize(value);
              return this.saveTyped();
            }
            typed = value;
            window.clearTimeout(pause);
            pause = window.setTimeout(commit, TYPING_PAUSE_MS);
          });
        if (onBlur) {
          input.inputEl.addEventListener("blur", commit);
          this.flushers.push(commit);
        }
      });
    };

    const brand = containerEl.createDiv({ cls: "specgit-settings-brand" });
    drawLogo(brand.createSpan({ cls: "specgit-settings-mark" }));
    const words = brand.createDiv({ cls: "specgit-settings-brand-words" });
    const wordmark = words.createSpan({ cls: "specgit-wordmark" });
    wordmark.append("spec");
    wordmark.createSpan({ cls: "specgit-wordmark-git" }).append("git");
    words.createEl("p", { text: TAGLINE, cls: "specgit-settings-line" });
    const links = words.createEl("p", { cls: "specgit-settings-links" });
    links.createEl("a", { text: "Help", href: supportPageUrl(this.host.config.server) });
    links.createEl("a", { text: "specgit.com", href: this.host.config.server });

    const { account } = this;
    const signedIn = account.signedIn();

    const keeping = signedIn ? (account.keeping?.() ?? null) : null;
    new Setting(containerEl)
      .setName("Account")
      .setDesc(keeping === null ? accountText(signedIn, this.host.config.login) : `${accountText(signedIn, this.host.config.login)} ${keeping.kept() ? KEPT_UNSECURED : NOT_KEPT}`)
      .addButton((button) => {
        button.setButtonText(signedIn ? "Sign out" : "Sign in").onClick(() => (signedIn ? account.signOut() : account.signIn()));
        if (!signedIn) button.setCta();
      });
    if (keeping !== null) {
      new Setting(containerEl).setName(KEEP_SIGNED_IN).addToggle((toggle) =>
        toggle.setValue(keeping.kept()).onChange((on) => {
          keeping.keep(on);
          this.display();
        }),
      );
    }
    new Setting(containerEl).setName("Live notes").setHeading();

    const { repo, folder } = this.host.config;
    new Setting(containerEl)
      .setName("Repository")
      .setDesc(repo === "" ? NO_REPOSITORY_YET : repo)
      .addButton((button) => {
        button.setButtonText(repo === "" ? CHOOSE_REPOSITORY : CHANGE).onClick(() => void this.picker.chooseRepository().then(() => this.display()));
        if (repo === "") button.setCta();
      });
    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc(repo === "" ? CHOOSE_A_REPOSITORY_FIRST : folder === "" ? WHOLE_VAULT : `${folder}. ${outsideStays(folder)}`)
      .addButton((button) => button.setButtonText(CHANGE).setDisabled(repo === "").onClick(() => void this.picker.chooseFolder().then(() => this.display())));
    text("color", new Setting(containerEl).setName("Cursor color").setDesc("The color other people see your cursor in, like #958DF1. Leave it empty and specgit picks one."), "#958DF1");

    const stayReady = signedIn && isRepoName(repo);
    const stay = this.host.config.stayConnected;
    new Setting(containerEl)
      .setName(STAY.name)
      .setDesc(`${STAY.what} ${STAY.whileOpen}${stay || stayReady ? "" : ` ${signedIn ? "Choose a repository first." : "Sign in first."}`}`)
      .addToggle((toggle) =>
        toggle
          .setValue(stay)
          .setDisabled(!stay && !stayReady)
          .onChange(async (value) => {
            await this.host.setStayConnected(value);

            this.display();
          }),
      );
    if (stay) {
      new Setting(containerEl)
        .setName(STAY_DRAFTS_WORDS.name)
        .setDesc(STAY_DRAFTS_WORDS.description)
        .addDropdown((dropdown) =>
          dropdown
            .addOption("everyone", STAY_DRAFTS_WORDS.everyone)
            .addOption("mine", STAY_DRAFTS_WORDS.mine)
            .setValue(this.host.config.stayDrafts)
            .onChange((value) => {
              this.host.config.stayDrafts = value === "mine" ? "mine" : "everyone";
              void this.host.saveConfig();
            }),
        );
    }
    new Setting(containerEl).setName("Help").setHeading();
    new Setting(containerEl)
      .setName("Report a problem")
      .setDesc("Tell the specgit team something went wrong. You choose what is sent.")
      .addButton((button) => button.setButtonText("Report a problem").onClick(() => this.reportProblem()));

    new Setting(containerEl).setName("Advanced").setHeading();
    text("server", new Setting(containerEl).setName("Server").setDesc("For specgit's own development. Restart Obsidian after changing it."), DEFAULT_SERVER, normalizeServer, true);
  }

  private async saveTyped(): Promise<void> {
    this.typing++;
    try {
      await this.host.saveConfig();
    } finally {
      this.typing--;
    }
  }

  override hide(): void {
    for (const flush of this.flushers) flush();
    this.stopWatching?.();
    this.stopWatching = null;
    this.stopWatchingSaves?.();
    this.stopWatchingSaves = null;
    const before = this.openedWith;
    this.openedWith = null;
    if (before !== null && before !== this.host.config.repo && this.host.config.repo.trim() !== "") this.host.linked?.();
  }
}
