import { type App, ButtonComponent, Setting } from "obsidian";
import { buttonRow, SpecgitModal } from "../brand/modal";
import { showNotice } from "../notices";
import { detailLines, ReportForm, SIGNED_OUT_WORDS, SUPPORT_EMAIL } from "./report";

export class ReportModal extends SpecgitModal {
  private problemEl!: HTMLElement;
  private detailsEl!: HTMLElement;
  private signedOutEl!: HTMLElement;
  private primary!: ButtonComponent;

  constructor(
    app: App,
    private readonly form: ReportForm,
    private readonly prefilled: boolean,
    private readonly sent: () => void = () => undefined,
  ) {
    super(app);
    this.setTitle("Report a problem");
    this.modalEl.addClass("specgit-report");
  }

  override onOpen(): void {
    const { contentEl, form } = this;

    contentEl.createEl("label", { text: "What happened?", cls: "specgit-report-label", attr: { for: "specgit-report-message" } });
    const message = contentEl.createEl("textarea", {
      cls: "specgit-report-message",
      attr: { id: "specgit-report-message", rows: "6", placeholder: "Tell us what you were doing and what went wrong." },
    });
    message.value = form.message;
    message.addEventListener("input", () => (form.message = message.value));
    if (this.prefilled) contentEl.createEl("p", { text: "This is the alert's text. It can name a note, so take out anything you'd rather not send.", cls: "specgit-report-hint" });

    contentEl.createEl("label", { text: "Email (optional)", cls: "specgit-report-label", attr: { for: "specgit-report-email" } });
    const email = contentEl.createEl("input", {
      cls: "specgit-report-email",
      attr: { id: "specgit-report-email", type: "email", placeholder: "you@example.com", autocomplete: "email" },
    });
    email.addEventListener("input", () => (form.email = email.value));
    contentEl.createEl("p", { text: "We can only reply if you fill this in.", cls: "specgit-report-hint" });

    new Setting(contentEl)
      .setName("Include setup details")
      .setDesc("Helps us find the problem. Never a note's name, path or text.")
      .addToggle((toggle) =>
        toggle.setValue(form.includeDetails).onChange((on) => {
          form.includeDetails = on;
          this.refresh();
        }),
      );
    this.detailsEl = contentEl.createEl("pre", { cls: "specgit-report-details" });

    this.signedOutEl = contentEl.createEl("p", { cls: "specgit-report-hint" });
    this.problemEl = contentEl.createDiv({ cls: "specgit-dialog-error specgit-report-problem", attr: { role: "alert" } });

    buttonRow(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => {
        this.primary = button.setCta().onClick(() => void this.submit());
      });
    this.refresh();
    message.focus();
  }

  private refresh(): void {
    const { form } = this;
    const details = form.details();
    this.detailsEl.empty();
    this.detailsEl.toggleClass("is-off", details === null);
    this.detailsEl.setText(details ? detailLines(details).join("\n") : "No setup details will be sent.");

    const copies = form.primary === "copy";
    this.primary.setButtonText(copies ? "Copy and open support" : "Send").setDisabled(form.busy);
    this.signedOutEl.setText(copies ? SIGNED_OUT_WORDS : "");

    this.problemEl.empty();
    const { problem } = form;
    if (!problem) return;
    this.problemEl.createEl("p", { text: problem.words });
    if (!problem.offerCopy) return;
    new Setting(this.problemEl).setName(`Or email ${SUPPORT_EMAIL}`).addButton((button) =>
      button.setButtonText("Copy report").onClick(async () => {
        if (await form.copyReport()) showNotice(`Report copied. Paste it into an email to ${SUPPORT_EMAIL}.`);
        this.refresh();
      }),
    );
  }

  private async submit(): Promise<void> {
    const { form } = this;
    if (form.busy) return;
    const pending = form.submit();
    this.refresh();
    const result = await pending;
    if (result.kind === "closed") {
      showNotice(result.notice);
      this.sent();
      this.close();
      return;
    }
    this.refresh();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
