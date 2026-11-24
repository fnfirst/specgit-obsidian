import { type App, type ButtonComponent, Setting, type TextComponent } from "obsidian";
import { buttonRow, SpecgitModal } from "./modal";
import { PUBLIC_REPO_CANCEL, PUBLIC_REPO_PROCEED, PUBLIC_REPO_TITLE, PUBLIC_REPO_WARNING, publicRepoPrompt } from "./public-repo-words";

export class PublicRepoConfirmModal extends SpecgitModal {
  private settled = false;

  constructor(
    app: App,
    private readonly repo: string,
    private readonly done: (confirmed: boolean) => void,
  ) {
    super(app);
    this.setTitle(PUBLIC_REPO_TITLE);
    this.modalEl.setAttribute("role", "alertdialog");
  }

  override onOpen(): void {
    const { contentEl } = this;
    let field: TextComponent | null = null;
    let proceedButton: ButtonComponent | null = null;
    const matches = (): boolean => (field?.getValue().trim() ?? "") === this.repo;
    const sync = (): void => {
      proceedButton?.setDisabled(!matches());
    };
    const submit = (): void => {
      if (!matches()) return;
      this.finish(true);
      this.close();
    };
    contentEl.createEl("p", { text: PUBLIC_REPO_WARNING, cls: "specgit-public-repo-warning" });
    const setting = new Setting(contentEl).setName(publicRepoPrompt(this.repo));
    setting.settingEl.addClass("specgit-public-repo-field");
    setting.addText((text) => {
      field = text;
      text.setPlaceholder(this.repo).onChange(sync);
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
    });
    buttonRow(contentEl)
      .addButton((button) => {
        button.setButtonText(PUBLIC_REPO_CANCEL).onClick(() => {
          this.finish(false);
          this.close();
        });
        button.buttonEl.addClass("mod-cancel");
      })
      .addButton((button) => {
        proceedButton = button;
        button.setButtonText(PUBLIC_REPO_PROCEED).setDisabled(true).onClick(submit);
        button.buttonEl.addClass("mod-warning");
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.finish(false);
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.done(confirmed);
  }
}
