import { type App, Setting, setIcon, setTooltip, type TextComponent } from "obsidian";
import { bringForward, buttonRow, SpecgitModal } from "../brand/modal";
import type { OnboardEvents, OnboardUi, OnboardView } from "./flow";
import { VAULT_MAX_FILES, VAULT_MAX_TOTAL_BYTES } from "../shared/review-flow";
import { safeRepoName } from "./plan";
import {
  CANCEL,
  CONNECT_GITHUB,
  CONTINUE_ON_GITHUB,
  CREATE,
  creating,
  DONE,
  DONE_TITLE,
  FORM_ACCESS,
  FORM_CREATE,
  FORM_LEAD,
  filesLine,
  FREE_IN_USE,
  GIVE_ACCESS,
  HIDE,
  KEEP_OPEN,
  LEAD,
  LOOK_AGAIN,
  LOOKING,
  moreSkippedFiles,
  NAME,
  NOT_HEARD,
  notSeen,
  OFFLINE,
  onGitHub,
  OPEN_AGAIN,
  OPEN_GITHUB,
  OPEN_ON_GITHUB,
  PRIVATE,
  PRIVATE_TIP,
  progressLine,
  reading,
  SETTINGS_LINE,
  SLOW_DOWN,
  START_AGAIN,
  STOP,
  TITLE,
  tooBig,
  tooLargeLine,
  tooMany,
  TRY_AGAIN,
  UPLOADING_TITLE,
  WAIT_ACCEPT,
  WAIT_INSTALL,
  WAITING_GITHUB,
  waitingFor,
} from "./words";

type NameView = Extract<OnboardView, { step: "name" }>;

export const MAX_SHOWN_TOO_LARGE = 5;

export function mainLabel(view: Pick<NameView, "signedIn" | "account" | "unread">): string {
  if (view.unread) return TRY_AGAIN;
  if (!view.signedIn) return CONNECT_GITHUB;
  switch (view.account?.next) {
    case "install":
    case "accept":
      return CONNECT_GITHUB;
    case "form":
      return CONTINUE_ON_GITHUB;
    default:
      return CREATE;
  }
}

export function limitLine(plan: NameView["plan"]): string | null {
  if (plan === null) return null;
  if (plan.totalBytes > VAULT_MAX_TOTAL_BYTES) return tooBig(plan.totalBytes);
  return plan.files.length > VAULT_MAX_FILES ? tooMany(plan.files.length) : null;
}

const isBlocked = (view: NameView): boolean => (view.plan === null && !view.unread) || limitLine(view.plan) !== null;

interface NameStep {
  value(): string;
  isPrivate(): boolean;
  showHint(): void;
  points: HTMLElement;
  problems: HTMLElement;
  buttons: HTMLElement;
}

export class OnboardModal extends SpecgitModal {
  private view: OnboardView = { step: "creating", name: "" };
  private on: OnboardEvents | null = null;
  private quiet = false;
  private opened = false;
  private nameStep: NameStep | null = null;

  constructor(
    app: App,
    private readonly gone: () => void,
  ) {
    super(app);
  }

  present(view: OnboardView, on: OnboardEvents): void {
    const { nameStep } = this;
    this.view = view;
    this.on = on;
    if (this.opened && nameStep !== null && view.step === "name") this.fillName(nameStep, view);
    else if (this.opened) this.draw();
    else {
      this.opened = true;
      this.open();
    }
  }

  closeQuietly(): void {
    this.quiet = true;
    this.close();
  }

  override onOpen(): void {
    this.draw();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.opened = false;
    this.gone();
    if (!this.quiet) this.on?.closed();
  }

  private draw(): void {
    const { view, contentEl } = this;
    this.nameStep = null;
    contentEl.empty();
    this.setTitle(view.step === "upload" ? UPLOADING_TITLE : view.step === "done" ? DONE_TITLE : TITLE);
    switch (view.step) {
      case "name":
        return this.drawName(view);
      case "creating":
        contentEl.createEl("p", { text: creating(view.name), cls: "specgit-dialog-text" });
        return;
      case "waiting":
        return this.drawWaiting(view);
      case "form":
        return this.drawForm(view);
      case "upload":
        return this.drawUpload(view);
      case "done":
        return this.drawButtons([{ label: OPEN_ON_GITHUB, run: () => this.on?.openOnGitHub() }, { label: DONE, run: () => this.close(), main: true }]);
      case "problem":
        contentEl.createEl("p", { text: view.line, cls: "specgit-dialog-text" });
        return this.drawButtons([view.action === "start_again" ? { label: START_AGAIN, run: () => this.on?.startAgain(), main: true } : view.action === "try_again" ? { label: TRY_AGAIN, run: () => this.on?.tryAgain(), main: true } : { label: CANCEL, run: () => this.close(), cancel: true }]);
    }
  }

  private drawButtons(buttons: Array<{ label: string; run: () => void; main?: boolean; cancel?: boolean; disabled?: boolean }>, parent: HTMLElement = this.contentEl): void {
    const row = buttonRow(parent);
    for (const { label, run, main, cancel, disabled } of buttons)
      row.addButton((button) => {
        button.setButtonText(label).onClick(run);
        if (main) button.setCta();
        if (cancel) button.buttonEl.addClass("mod-cancel");
        if (disabled) button.setDisabled(true);
      });
  }

  private drawName(view: NameView): void {
    const { contentEl } = this;
    let isPrivate = view.private;
    let field: TextComponent;
    contentEl.createEl("p", { text: LEAD, cls: "specgit-dialog-text" });
    const showHint = (): void => {
      const typed = field.getValue();
      const safe = safeRepoName(typed);
      const words = safe !== null && safe !== typed ? onGitHub(safe) : "";
      hint.setText(words);
      hint.hidden = words === "";
    };
    new Setting(contentEl).setName(NAME).addText((text) => {
      field = text;
      text.setValue(view.typed).onChange((value) => {
        showHint();
        this.on?.edit(value, isPrivate);
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && this.view.step === "name" && !isBlocked(this.view)) this.on?.press(text.getValue(), isPrivate);
      });
    });
    const hint = contentEl.createEl("p", { cls: "specgit-hint" });
    showHint();
    new Setting(contentEl).setName(PRIVATE).addToggle((toggle) => {
      toggle.setValue(isPrivate).onChange((value) => {
        isPrivate = value;
        this.on?.edit(field.getValue(), isPrivate);
      });
      setTooltip(toggle.toggleEl, PRIVATE_TIP);
    });
    this.nameStep = {
      value: () => field.getValue(),
      isPrivate: () => isPrivate,
      showHint,
      points: contentEl.createDiv(),
      problems: contentEl.createDiv(),
      buttons: contentEl.createDiv(),
    };
    this.fillName(this.nameStep, view);
  }

  private fillName(step: NameStep, view: NameView): void {
    step.points.empty();
    step.problems.empty();
    step.buttons.empty();
    step.showHint();
    const limit = limitLine(view.plan);
    if (view.plan === null) {
      if (!view.unread) step.points.createEl("p", { text: LOOKING, cls: "specgit-hint" });
    } else {
      const { plan } = view;
      const points: Array<{ icon: string; text: string; skipped?: readonly string[] }> = [
        { icon: "file-text", text: filesLine(plan.notes, plan.others, plan.othersAndNotesBytes) },
        { icon: "settings", text: SETTINGS_LINE },
        ...(plan.tooLarge.length > 0 ? [{ icon: "alert-triangle", text: tooLargeLine(plan.tooLarge.length), skipped: plan.tooLarge }] : []),
        ...(view.account?.freeInUse ? [{ icon: "info", text: FREE_IN_USE }] : []),
      ];
      const list = step.points.createEl("ul", { cls: "specgit-dialog-points" });
      for (const point of points) {
        const line = list.createEl("li");
        setIcon(line.createSpan({ cls: "specgit-dialog-point-icon" }), point.icon);
        line.createSpan({ text: point.text });
        if (point.skipped) {
          const skipped = line.createEl("ul", { cls: "specgit-onboard-skipped" });
          for (const path of point.skipped.slice(0, MAX_SHOWN_TOO_LARGE)) {
            skipped.createEl("li", { text: path });
          }
          const extra = point.skipped.length - MAX_SHOWN_TOO_LARGE;
          if (extra > 0) {
            skipped.createEl("li", { text: moreSkippedFiles(extra), cls: "specgit-onboard-skipped-more" });
          }
        }
      }
    }
    for (const line of [view.problem, limit]) if (line) step.problems.createEl("p", { text: line, cls: "specgit-dialog-error" });
    this.drawButtons(
      [
        { label: CANCEL, run: () => this.close(), cancel: true },
        { label: mainLabel(view), run: () => this.on?.press(step.value(), step.isPrivate()), main: true, disabled: isBlocked(view) },
      ],
      step.buttons,
    );
  }

  private drawWaiting(view: Extract<OnboardView, { step: "waiting" }>): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: view.why === "install" ? WAIT_INSTALL : WAIT_ACCEPT, cls: "specgit-dialog-text" });
    contentEl.createEl("p", { text: view.notSeen ? NOT_HEARD : WAITING_GITHUB, cls: "specgit-hint" });
    this.drawButtons([
      { label: CANCEL, run: () => this.close(), cancel: true },
      ...(view.notSeen ? [{ label: LOOK_AGAIN, run: () => this.on?.lookAgain() }] : []),
      { label: OPEN_AGAIN, run: () => this.on?.openAgain(), main: true },
    ]);
  }

  private drawForm(view: Extract<OnboardView, { step: "form" }>): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: FORM_LEAD, cls: "specgit-dialog-text" });
    const rows = [{ words: FORM_CREATE, label: OPEN_GITHUB, run: () => this.on?.openGithub() }, ...(view.canGiveAccess ? [{ words: FORM_ACCESS, label: GIVE_ACCESS, run: () => this.on?.giveAccess() }] : [])];
    for (const { words, label, run } of rows) new Setting(contentEl).setName(words).addButton((button) => button.setButtonText(label).onClick(run));
    contentEl.createEl("p", { text: view.notSeen ? notSeen(view.name) : waitingFor(view.name), cls: "specgit-hint" });
    this.drawButtons([{ label: CANCEL, run: () => this.close(), cancel: true }, ...(view.notSeen ? [{ label: LOOK_AGAIN, run: () => this.on?.lookAgain(), main: true }] : [])]);
  }

  private drawUpload(view: Extract<OnboardView, { step: "upload" }>): void {
    const { contentEl } = this;
    const { kind, done, total, waiting } = view.progress;
    contentEl.createEl("progress", { cls: "specgit-onboard-progress", attr: { max: String(total), value: String(done) } });
    contentEl.createEl("p", { text: kind === "reading" ? reading(done, total) : progressLine(done, total), cls: "specgit-dialog-text" });
    contentEl.createEl("p", { text: KEEP_OPEN, cls: "specgit-hint" });
    if (waiting !== null) contentEl.createEl("p", { text: waiting === "slow" ? SLOW_DOWN : OFFLINE, cls: "specgit-hint" });
    this.drawButtons([
      { label: STOP, run: () => this.on?.stop() },
      { label: HIDE, run: () => this.close(), main: true },
    ]);
  }
}

export class OnboardWindow implements OnboardUi {
  private modal: OnboardModal | null = null;

  constructor(private readonly app: App) {}

  show(view: OnboardView, on: OnboardEvents): void {
    this.modal ??= new OnboardModal(this.app, () => void (this.modal = null));
    this.modal.present(view, on);
  }

  close(): void {
    const modal = this.modal;
    this.modal = null;
    modal?.closeQuietly();
  }

  bringForward(): boolean {
    return this.modal !== null && bringForward(this.modal);
  }
}
