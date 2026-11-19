import type { LeftOut } from "../changes/left-out";
import { type App, FuzzySuggestModal } from "obsidian";
import { buttonRow, SpecgitModal } from "../brand/modal";
import { CANCEL } from "../onboard/words";
import { reportIfNotChosen } from "./closing";
import type { FolderProposal } from "./folder";
import { CHOOSE_ANOTHER_FOLDER, LOADING_FOLDER, CHOOSE_FOLDER, FOLDER_PLACEHOLDER, FOLDER_TITLE, FOLDER_UNREAD, hiddenWords, holdsFiles, matchCount, mirrorsRepository, noFilesInVault, outsideStays, USE_IT, WHOLE_VAULT } from "./words";

export type FolderAnswer = "use" | "whole" | "other";

export interface FolderQuestion {
  repo: string;
  proposal: FolderProposal | null;

  unread: boolean;

  total: number;

  hidden: number;
}

export interface CopyInQuestion {
  repo: string;
  count: number;

  hidden: number;

  leftOut: LeftOut;
}

export interface SwitchQuestion {
  from: string;
  to: string;
  unsent: number | null;
}

export function folderChoices(question: FolderQuestion): Array<{ answer: FolderAnswer; label: string; primary: boolean }> {
  const { proposal } = question;
  if (proposal === null) return [{ answer: "whole", label: WHOLE_VAULT, primary: true }, { answer: "other", label: CHOOSE_FOLDER, primary: false }];
  if (proposal.folder === "") return [{ answer: "use", label: USE_IT, primary: true }, { answer: "other", label: CHOOSE_ANOTHER_FOLDER, primary: false }];
  return [
    { answer: "use", label: USE_IT, primary: true },
    { answer: "whole", label: WHOLE_VAULT, primary: false },
    { answer: "other", label: CHOOSE_ANOTHER_FOLDER, primary: false },
  ];
}

export function folderWords(question: FolderQuestion): string {
  const { proposal } = question;
  if (proposal === null) return question.unread ? FOLDER_UNREAD : noFilesInVault(question.repo, question.total);
  return proposal.folder === "" ? mirrorsRepository(question.repo) : holdsFiles(proposal.folder);
}

export const folderNote = (question: FolderQuestion): string | null => (question.proposal !== null && question.proposal.folder !== "" ? outsideStays(question.proposal.folder) : null);

export class FolderConfirmModal extends SpecgitModal {
  private answered = false;
  private isShown = false;

  constructor(
    app: App,
    private readonly question: FolderQuestion | Promise<FolderQuestion>,
    private readonly done: (answer: FolderAnswer | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.isShown = true;
    this.setTitle(FOLDER_TITLE);
    if (!(this.question instanceof Promise)) return this.draw(this.question);
    this.contentEl.createEl("p", { text: LOADING_FOLDER, cls: "specgit-hint" });
    void this.question.then((question) => {
      if (!this.isShown) return;
      this.contentEl.empty();
      this.draw(question);
    });
  }

  private draw(question: FolderQuestion): void {
    this.contentEl.createEl("p", { text: folderWords(question) });
    const { proposal } = question;
    if (proposal !== null) this.contentEl.createEl("p", { text: matchCount(proposal.matched, proposal.total), cls: "specgit-hint" });
    const note = folderNote(question);
    if (note !== null) this.contentEl.createEl("p", { text: note, cls: "specgit-hint" });
    if (question.hidden > 0) this.contentEl.createEl("p", { text: hiddenWords(question.hidden), cls: "specgit-hint" });
    const buttons = buttonRow(this.contentEl);
    for (const choice of folderChoices(question)) {
      buttons.addButton((button) => {
        button.setButtonText(choice.label).onClick(() => this.answer(choice.answer));
        if (choice.primary) button.setCta();
      });
    }

    buttons.addButton((button) => button.setButtonText(CANCEL).onClick(() => this.close()));
  }

  override onClose(): void {
    this.isShown = false;
    this.contentEl.empty();
    if (!this.answered) this.done(null);
  }

  private answer(answer: FolderAnswer): void {
    this.answered = true;
    this.done(answer);
    this.close();
  }
}

export class FolderSuggestModal extends FuzzySuggestModal<string> {
  private chosen = false;

  constructor(
    app: App,
    private readonly folders: readonly string[],
    private readonly done: (folder: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder(FOLDER_PLACEHOLDER);
  }

  getItems(): string[] {
    return ["", ...this.folders];
  }

  getItemText(folder: string): string {
    return folder === "" ? WHOLE_VAULT : folder;
  }

  onChooseItem(folder: string): void {
    this.chosen = true;
    this.done(folder);
  }

  override onClose(): void {
    super.onClose();
    reportIfNotChosen(() => this.chosen, () => this.done(null));
  }
}
