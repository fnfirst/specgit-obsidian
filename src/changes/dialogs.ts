import { type App, Setting, setIcon } from "obsidian";
import { h, render } from "preact";
import { buttonRow, SpecgitModal } from "../brand/modal";
import { Face } from "../people/face";
import type { Reviewer } from "../review/review-api";
import { showNotice } from "../notices";
import { noticeText } from "../review/words";
import type { ConfirmQuestion } from "../shared/status-panel";
import { type DialogWords, dialogText, type Dialogs } from "./flow-deps";

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const NOT_A_LOGIN = "That doesn't look like a GitHub username.";

type Answer = "confirm" | "cancel" | "closed";

class AskModal extends SpecgitModal {
  private answered: Answer | null = null;

  constructor(
    app: App,
    private readonly options: { title: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean; href?: string | null; hrefLabel?: string; alertOnly?: boolean; reportThis?: () => void } & DialogWords,
    private readonly done: (answer: Answer) => void,
  ) {
    super(app);
    this.setTitle(options.title);
    this.modalEl.setAttribute("role", options.alertOnly ? "alertdialog" : "dialog");
  }

  override onOpen(): void {
    const { options } = this;
    if (options.description) this.contentEl.createEl("p", { text: options.description, cls: "specgit-dialog-text" });

    if (options.points?.length) {
      const list = this.contentEl.createEl("ul", { cls: "specgit-dialog-points" });
      for (const point of options.points) {
        const line = list.createEl("li");
        setIcon(line.createSpan({ cls: "specgit-dialog-point-icon" }), point.icon);
        line.createSpan({ text: point.text });
      }
    }
    if (options.note) this.contentEl.createEl("p", { text: options.note, cls: "specgit-dialog-note" });
    if (options.href) this.contentEl.createEl("a", { text: options.hrefLabel ?? "Open", href: options.href, cls: "specgit-dialog-link" });
    const row = buttonRow(this.contentEl);

    const { reportThis } = options;
    if (reportThis) {
      row.addButton((button) => {
        button.setButtonText("Report this").onClick(() => {
          this.close();
          reportThis();
        });
        button.buttonEl.addClass("mod-secondary");
      });
    }
    if (!options.alertOnly) {
      row.addButton((button) => {
        button.setButtonText(options.cancelLabel ?? "Cancel").onClick(() => {
          this.answered = "cancel";
          this.close();
        });
        button.buttonEl.addClass("mod-cancel");
      });
    }
    row.addButton((button) => {
      button.setButtonText(options.confirmLabel).onClick(() => {
        this.answered = "confirm";
        this.close();
      });
      if (options.destructive) button.buttonEl.addClass("mod-warning");
      else button.setCta();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(this.answered ?? "closed");
  }
}

class NoteModal extends SpecgitModal {
  private note: string | null = null;

  constructor(
    app: App,
    private readonly options: { title: string; description: string; label: string; placeholder: string; confirmLabel: string; required: string },
    private readonly done: (note: string | null) => void,
  ) {
    super(app);
    this.setTitle(options.title);
  }

  override onOpen(): void {
    const { contentEl, options } = this;
    contentEl.createEl("p", { text: options.description, cls: "specgit-dialog-text" });
    let typed = "";
    const error = contentEl.createEl("p", { cls: "specgit-dialog-error" });
    new Setting(contentEl).setName(options.label).addTextArea((area) => {
      area.setPlaceholder(options.placeholder).onChange((value) => (typed = value));
      area.inputEl.rows = 4;
    });
    const row = buttonRow(contentEl);
    row.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
    row.addButton((button) =>
      button.setButtonText(options.confirmLabel).setCta().onClick(() => {
        if (typed.trim() === "") return void error.setText(options.required);
        this.note = typed.trim();
        this.close();
      }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(this.note);
  }
}

class ChoicesModal extends SpecgitModal {
  private answered = "";

  constructor(
    app: App,
    private readonly question: ConfirmQuestion,
    private readonly done: (id: string) => void,
  ) {
    super(app);
    this.setTitle(question.title);
    this.modalEl.setAttribute("role", "dialog");
  }

  override onOpen(): void {
    const row = buttonRow(this.contentEl);
    for (const choice of this.question.choices) {
      row.addButton((button) => {
        button.setButtonText(choice.label).onClick(() => {
          this.answered = choice.id;
          this.close();
        });
        if (choice.primary) button.setCta();
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(this.answered);
  }
}

export const askChoices = (app: App, question: ConfirmQuestion): Promise<string> => new Promise((resolve) => new ChoicesModal(app, question, resolve).open());

class ReviewerModal extends SpecgitModal {
  private picked: Reviewer | null = null;

  constructor(
    app: App,
    private readonly candidates: readonly Reviewer[],
    private readonly description: string,
    private readonly done: (reviewer: Reviewer | null) => void,
  ) {
    super(app);
    this.setTitle("Ask for review");
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.description });
    for (const reviewer of this.candidates) {
      const row = new Setting(contentEl).setName(reviewer.login).addButton((button) => button.setButtonText("Ask").onClick(() => this.choose(reviewer)));

      row.nameEl.classList.add("specgit-reviewer-name");
      const face = row.nameEl.createSpan();
      row.nameEl.prepend(face);
      render(h(Face, { src: reviewer.avatarUrl, name: reviewer.login }), face);
    }
    const error = contentEl.createEl("p", { cls: "specgit-dialog-error" });
    let typed = "";
    new Setting(contentEl)
      .setName(this.candidates.length ? "Or type a GitHub username" : "Their GitHub username")
      .addText((text) => text.setPlaceholder("Username").onChange((value) => (typed = value.trim())))
      .addButton((button) =>
        button.setButtonText("OK").setCta().onClick(() => {
          if (!LOGIN.test(typed)) error.setText(NOT_A_LOGIN);

          else this.choose({ login: typed, avatarUrl: null });
        }),
      );
  }

  private choose(reviewer: Reviewer): void {
    this.picked = reviewer;
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(this.picked);
  }
}

export function obsidianDialogs(app: App, reportThis: (title: string, description?: string) => void): Dialogs {
  return {

    confirm: (options) => new Promise((resolve) => new AskModal(app, options, (answer) => resolve(answer === "confirm")).open()),
    choose: (options) => new Promise((resolve) => new AskModal(app, options, (answer) => resolve(answer === "closed" ? null : answer === "confirm")).open()),
    alert: (options) =>
      new Promise((resolve) => {
        new AskModal(app, { ...options, confirmLabel: "OK", alertOnly: true, reportThis: () => reportThis(options.title, dialogText(options) || undefined) }, () => resolve()).open();
      }),
    toast: (title, description) => showNotice(noticeText(title, description)),
    askNote: (options) => new Promise((resolve) => new NoteModal(app, options, resolve).open()),
    pickReviewer: (candidates, description) => new Promise((resolve) => new ReviewerModal(app, candidates, description, resolve).open()),
  };
}
