import { buttonRow, SpecgitModal } from "../brand/modal";
import { Setting, type App } from "obsidian";
import { PENDING_TTL_MS } from "./storage";

export const SIGN_IN_WAITING = "Choose Allow in your browser. This window closes by itself once you're signed in.";
export const CONFIRM_PHRASE_PREFIX = "Check that your browser shows: ";
export const REOPEN_BROWSER = "Open the browser again";
export const DIDNT_COME_BACK = "Paste a code instead";
export const PASTE_CODE_HELP = "Paste the code that specgit.com shows.";
export const FINISH_SIGN_IN = "Finish signing in";
export const DIDNT_FINISH = "This sign-in didn't finish.";
export const SIGN_IN_AGAIN = "Sign in again";
export const CLOSE = "Close";

export interface PasteCodeModalOptions {
  signInAgain?: () => void;
  lastsMs?: number;
  confirmPhrase?: string;
}

export class PasteCodeModal extends SpecgitModal {
  private code = "";
  private working = false;
  private errorEl: HTMLElement | null = null;
  private timer: number | null = null;
  private closed = true;
  private over = false;

  constructor(
    app: App,
    private readonly submit: (code: string) => Promise<void>,
    private readonly reopen: () => void = () => undefined,
    private readonly options: PasteCodeModalOptions = {},
  ) {
    super(app);
  }

  override close(): void {
    if (this.closed) return;
    this.closed = true;
    super.close();
  }

  override open(): void {
    this.closed = false;
    this.over = false;
    super.open();
  }

  override onOpen(): void {
    this.setTitle("Finish signing in to specgit");
    this.stopWaiting();
    this.timer = window.setTimeout(() => this.didntFinish(), this.options.lastsMs ?? PENDING_TTL_MS);
    this.contentEl.createEl("p", { text: SIGN_IN_WAITING });
    if (this.options.confirmPhrase) {
      const confirm = this.contentEl.createEl("p", { cls: "specgit-signin-confirm", text: CONFIRM_PHRASE_PREFIX });
      confirm.createEl("strong", { cls: "specgit-signin-confirm-phrase", text: this.options.confirmPhrase });
    }
    buttonRow(this.contentEl).addButton((button) => button.setButtonText(REOPEN_BROWSER).onClick(() => this.reopen()));

    const fallback = this.contentEl.createEl("details", { cls: "specgit-signin-fallback" });
    fallback.createEl("summary", { text: DIDNT_COME_BACK });
    fallback.createEl("p", { text: PASTE_CODE_HELP });
    new Setting(fallback).setName("Code").addText((text) => {
      text.setPlaceholder("Paste the code").onChange((value) => void (this.code = value));
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void this.send();
      });
    });
    this.errorEl = fallback.createEl("p", { cls: "mod-warning" });
    buttonRow(fallback).addButton((button) => button.setButtonText(FINISH_SIGN_IN).setCta().onClick(() => void this.send()));
  }

  override onClose(): void {
    this.stopWaiting();
    this.contentEl.empty();
  }

  private stopWaiting(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  didntFinish(): void {
    if (this.closed || this.over) return;
    this.over = true;
    this.stopWaiting();
    this.contentEl.empty();
    this.errorEl = null;
    this.contentEl.createEl("p", { text: DIDNT_FINISH });
    buttonRow(this.contentEl)
      .addButton((button) => button.setButtonText(CLOSE).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(SIGN_IN_AGAIN)
          .setCta()
          .onClick(() => {
            this.close();
            this.options.signInAgain?.();
          }),
      );
  }

  private async send(): Promise<void> {
    if (this.working) return;
    this.working = true;
    this.errorEl?.setText("");
    try {
      await this.submit(this.code);
      this.close();
    } catch (error) {
      this.errorEl?.setText(error instanceof Error ? error.message : "That didn't work. Try again.");
    } finally {
      this.working = false;
    }
  }
}
