import { type App, type Plugin, PluginSettingTab, requireApiVersion, Setting, type SettingDefinitionItem } from "obsidian";
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
    } catch {
      void 0;
    }
    const given = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
    return { stayConnected: given.stayConnected === true, stayOffered: given.stayOffered === true };
  }

  write(settings: Pick<Settings, "stayConnected" | "stayOffered">): void {
    try {
      this.state.save(DEVICE_KEY, { stayConnected: settings.stayConnected, stayOffered: settings.stayOffered });
    } catch {
      void 0;
    }
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

const CURSOR_COLOR_DESC = "The color other people see your cursor in, like #958DF1. Leave it empty and specgit picks one.";
const REPORT_DESC = "Tell the specgit team something went wrong. You choose what is sent.";
const SERVER_DESC = "For specgit's own development. Restart Obsidian after changing it.";

interface SpecgitRow {
  name: string;
  desc?: string;
  searchable?: boolean;
  visible?: boolean | (() => boolean);
  render: (setting: Setting) => void | (() => void);
}

interface SpecgitGroup {
  type: "group";
  heading: string;
  items: SpecgitRow[];
}

type SpecgitItem = SpecgitRow | SpecgitGroup;

function renderRow(containerEl: HTMLElement, row: SpecgitRow): void {
  const visible = typeof row.visible === "function" ? row.visible() : (row.visible ?? true);
  if (!visible) return;
  const setting = new Setting(containerEl).setName(row.name);
  if (row.desc) setting.setDesc(row.desc);
  row.render(setting);
}

export class SpecgitSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;
  private stopWatching: (() => void) | null = null;
  private stopWatchingSaves: (() => void) | null = null;
  private typing = 0;
  private flushers: Array<() => void> = [];
  private openedWith: string | null = null;
  private declarative = false;
  private mounted = 0;
  private updating = false;

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

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const mount = (row: SpecgitRow): SpecgitRow => ({
      ...row,
      render: (setting) => {
        this.declarative = true;
        this.mounted++;
        this.attach();
        const teardown = row.render(setting);
        let cleaned = false;
        return () => {
          if (cleaned) return;
          cleaned = true;
          teardown?.();
          this.mounted = Math.max(0, this.mounted - 1);
          if (this.mounted === 0 && !this.updating) this.detach();
        };
      },
    });
    const brandRow: SpecgitRow = mount({
      name: "",
      searchable: false,
      render: (setting) => {
        setting.settingEl.addClass("specgit-settings-brand-row");
        setting.settingEl.empty();
        this.drawBrand(setting.settingEl);
      },
    });
    const mounted = this.buildSections().map((item): SpecgitItem => ("type" in item ? { ...item, items: item.items.map(mount) } : mount(item)));
    return [brandRow, ...mounted];
  }

  override display(): void {
    this.declarative = false;
    this.mounted = 0;
    this.flush();
    this.containerEl.empty();
    this.attach();
    this.drawBrand(this.containerEl);
    for (const item of this.buildSections()) {
      if ("type" in item) {
        new Setting(this.containerEl).setName(item.heading).setHeading();
        for (const row of item.items) renderRow(this.containerEl, row);
      } else {
        renderRow(this.containerEl, item);
      }
    }
  }

  private attach(): void {
    this.openedWith ??= this.host.config.repo;
    this.stopWatching ??= this.account.onChange(() => this.redraw());
    this.stopWatchingSaves ??= this.host.onSaved?.(() => {
      if (this.typing === 0) this.redraw();
    }) ?? null;
  }

  private redraw(): void {
    if (requireApiVersion("1.13.0") && this.declarative) {
      this.flush();
      this.updating = true;
      try {
        this.update();
      } finally {
        this.updating = false;
      }
    } else {
      this.display();
    }
  }

  private flush(): void {
    for (const commit of this.flushers.splice(0)) commit();
  }

  private keeping(): SignInKeeping | null {
    return this.account.signedIn() ? (this.account.keeping?.() ?? null) : null;
  }

  private accountDesc(): string {
    const signedIn = this.account.signedIn();
    const keeping = this.keeping();
    return keeping === null ? accountText(signedIn, this.host.config.login) : `${accountText(signedIn, this.host.config.login)} ${keeping.kept() ? KEPT_UNSECURED : NOT_KEPT}`;
  }

  private repoDesc(): string {
    return this.host.config.repo === "" ? NO_REPOSITORY_YET : this.host.config.repo;
  }

  private folderDesc(): string {
    const { repo, folder } = this.host.config;
    return repo === "" ? CHOOSE_A_REPOSITORY_FIRST : folder === "" ? WHOLE_VAULT : `${folder}. ${outsideStays(folder)}`;
  }

  private stayDesc(): string {
    const signedIn = this.account.signedIn();
    const stayReady = signedIn && isRepoName(this.host.config.repo);
    const stay = this.host.config.stayConnected;
    return `${STAY.what} ${STAY.whileOpen}${stay || stayReady ? "" : ` ${signedIn ? "Choose a repository first." : "Sign in first."}`}`;
  }

  private drawBrand(parent: HTMLElement): void {
    const brand = parent.createDiv({ cls: "specgit-settings-brand" });
    drawLogo(brand.createSpan({ cls: "specgit-settings-mark" }));
    const words = brand.createDiv({ cls: "specgit-settings-brand-words" });
    const wordmark = words.createSpan({ cls: "specgit-wordmark" });
    wordmark.append("spec");
    wordmark.createSpan({ cls: "specgit-wordmark-git" }).append("git");
    words.createEl("p", { text: TAGLINE, cls: "specgit-settings-line" });
    const links = words.createEl("p", { cls: "specgit-settings-links" });
    links.createEl("a", { text: "Help", href: supportPageUrl(this.host.config.server) });
    links.createEl("a", { text: "specgit.com", href: this.host.config.server });
  }

  private bindText(key: TypedSetting, setting: Setting, placeholder: string, normalize: (value: string) => string = (value) => value.trim(), onBlur = false): (() => void) | void {
    let cleanup: (() => void) | undefined;
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
        cleanup = () => {
          input.inputEl.removeEventListener("blur", commit);
          commit();
          const at = this.flushers.indexOf(commit);
          if (at !== -1) this.flushers.splice(at, 1);
        };
      }
    });
    return cleanup;
  }

  private buildSections(): SpecgitItem[] {
    const top: SpecgitRow[] = [
      {
        name: "Account",
        desc: this.accountDesc(),
        render: (setting) => {
          const signedIn = this.account.signedIn();
          setting.setDesc(this.accountDesc());
          setting.addButton((button) => {
            button.setButtonText(signedIn ? "Sign out" : "Sign in").onClick(() => (signedIn ? this.account.signOut() : this.account.signIn()));
            if (!signedIn) button.setCta();
          });
        },
      },
      {
        name: KEEP_SIGNED_IN,
        visible: () => this.keeping() !== null,
        render: (setting) => {
          const keeping = this.keeping();
          if (keeping === null) return;
          setting.addToggle((toggle) =>
            toggle.setValue(keeping.kept()).onChange((on) => {
              keeping.keep(on);
              this.redraw();
            }),
          );
        },
      },
    ];

    const liveNotes: SpecgitGroup = {
      type: "group",
      heading: "Live notes",
      items: [
        {
          name: "Repository",
          desc: this.repoDesc(),
          render: (setting) => {
            const { repo } = this.host.config;
            setting.setDesc(this.repoDesc());
            setting.addButton((button) => {
              button.setButtonText(repo === "" ? CHOOSE_REPOSITORY : CHANGE).onClick(() => void this.picker.chooseRepository().then(() => this.redraw()));
              if (repo === "") button.setCta();
            });
          },
        },
        {
          name: "Vault folder",
          desc: this.folderDesc(),
          render: (setting) => {
            const { repo } = this.host.config;
            setting.setDesc(this.folderDesc());
            setting.addButton((button) => button.setButtonText(CHANGE).setDisabled(repo === "").onClick(() => void this.picker.chooseFolder().then(() => this.redraw())));
          },
        },
        {
          name: "Cursor color",
          desc: CURSOR_COLOR_DESC,
          render: (setting) => this.bindText("color", setting, "#958DF1"),
        },
        {
          name: STAY.name,
          desc: this.stayDesc(),
          render: (setting) => {
            const stayReady = this.account.signedIn() && isRepoName(this.host.config.repo);
            const stay = this.host.config.stayConnected;
            setting.setDesc(this.stayDesc());
            setting.addToggle((toggle) =>
              toggle
                .setValue(stay)
                .setDisabled(!stay && !stayReady)
                .onChange(async (value) => {
                  await this.host.setStayConnected(value);
                  this.redraw();
                }),
            );
          },
        },
        {
          name: STAY_DRAFTS_WORDS.name,
          desc: STAY_DRAFTS_WORDS.description,
          visible: () => this.host.config.stayConnected,
          render: (setting) => {
            setting.addDropdown((dropdown) =>
              dropdown
                .addOption("everyone", STAY_DRAFTS_WORDS.everyone)
                .addOption("mine", STAY_DRAFTS_WORDS.mine)
                .setValue(this.host.config.stayDrafts)
                .onChange((value) => {
                  this.host.config.stayDrafts = value === "mine" ? "mine" : "everyone";
                  void this.host.saveConfig();
                }),
            );
          },
        },
      ],
    };

    const help: SpecgitGroup = {
      type: "group",
      heading: "Help",
      items: [
        {
          name: "Report a problem",
          desc: REPORT_DESC,
          render: (setting) => {
            setting.addButton((button) => button.setButtonText("Report a problem").onClick(() => this.reportProblem()));
          },
        },
      ],
    };

    const advanced: SpecgitGroup = {
      type: "group",
      heading: "Advanced",
      items: [
        {
          name: "Server",
          desc: SERVER_DESC,
          render: (setting) => this.bindText("server", setting, DEFAULT_SERVER, normalizeServer, true),
        },
      ],
    };

    return [...top, liveNotes, help, advanced];
  }

  private async saveTyped(): Promise<void> {
    this.typing++;
    try {
      await this.host.saveConfig();
    } finally {
      this.typing--;
    }
  }

  private detach(): void {
    this.flush();
    this.stopWatching?.();
    this.stopWatching = null;
    this.stopWatchingSaves?.();
    this.stopWatchingSaves = null;
    const before = this.openedWith;
    this.openedWith = null;
    if (before !== null && before !== this.host.config.repo && this.host.config.repo.trim() !== "") this.host.linked?.();
  }

  override hide(): void {
    this.mounted = 0;
    this.detach();
  }
}
