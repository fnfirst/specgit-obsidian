import { type App, SuggestModal } from "obsidian";
import { reportIfNotChosen } from "./closing";
import { emptyWords, type RepoChoice, type RepoList, type Row, rowsFor } from "./repo-list";
import { CAN_WRITE, NOT_INSTALLED, NOT_LISTED, PRIVATE_WORD, PUBLIC_WORD, READ_ONLY, SEARCH_PLACEHOLDER, TRY_AGAIN, useRepository } from "./words";
import { GIVE_ACCESS_LABEL } from "../changes/words";
import { ONBOARD, PICKER_META } from "../onboard/words";

export interface RepoModalDeps {

  load(): Promise<RepoList>;

  choose(name: string): void;

  giveAccess(repo: RepoChoice): void;

  retry(): void;

  dismissed(): void;

  onboard?(): void;
}

export const accessWords = (repo: RepoChoice): string => (repo.access === "writable" ? CAN_WRITE : repo.access === "read_only" ? READ_ONLY : NOT_INSTALLED);

export class RepoSuggestModal extends SuggestModal<Row> {
  private list: RepoList | null = null;
  private chosen = false;
  private note: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly deps: RepoModalDeps,
  ) {
    super(app);
    this.setPlaceholder(SEARCH_PLACEHOLDER);
    this.emptyStateText = emptyWords(null, "");
    this.limit = 100;
  }

  override onOpen(): void {
    void super.onOpen();
    this.note = createDiv({ cls: "specgit-pick-note" });
    this.resultContainerEl.before(this.note);
    this.showNote();
    void this.deps.load().then((list) => {
      this.list = list;
      this.showNote();

      this.inputEl.dispatchEvent(new Event("input"));
    });
  }

  override onClose(): void {
    super.onClose();
    this.note?.remove();
    reportIfNotChosen(() => this.chosen, () => this.deps.dismissed());
  }

  private showNote(): void {
    if (!this.note) return;
    const failed = this.list !== null && this.list.kind !== "ok";
    this.note.setText(failed ? emptyWords(this.list, "") : "");
    this.note.toggleClass("is-shown", failed);
    this.emptyStateText = emptyWords(this.list, this.inputEl.value);
  }

  getSuggestions(query: string): Row[] {
    this.emptyStateText = emptyWords(this.list, query);
    return rowsFor(this.list, query, this.deps.onboard !== undefined);
  }

  renderSuggestion(row: Row, el: HTMLElement): void {
    el.addClass("specgit-pick-row");
    if (row.kind === "onboard") {
      el.createDiv({ text: ONBOARD, cls: "specgit-pick-name" });
      el.createDiv({ text: PICKER_META, cls: "specgit-pick-meta" });
      return;
    }
    if (row.kind === "retry") {
      el.createDiv({ text: TRY_AGAIN, cls: "specgit-pick-name" });
      return;
    }
    if (row.kind === "use") {
      el.createDiv({ text: useRepository(row.name), cls: "specgit-pick-name" });
      el.createDiv({ text: NOT_LISTED, cls: "specgit-pick-meta" });
      return;
    }
    const { repo } = row;
    el.createDiv({ text: repo.fullName, cls: "specgit-pick-name" });
    const meta = el.createDiv({ cls: "specgit-pick-meta" });
    meta.createSpan({ text: repo.private ? PRIVATE_WORD : PUBLIC_WORD });
    meta.createSpan({ text: accessWords(repo), cls: repo.access === "writable" ? "specgit-pick-can" : "specgit-pick-cannot" });
    if (repo.access === "not_installed") {

      el.createEl("button", { text: GIVE_ACCESS_LABEL, cls: "specgit-button specgit-pick-access" }, (button) =>
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          event.preventDefault();
          this.deps.giveAccess(repo);
        }),
      );
    }
  }

  onChooseSuggestion(row: Row): void {
    this.chosen = true;
    if (row.kind === "retry") this.deps.retry();
    else if (row.kind === "onboard") this.deps.onboard?.();
    else this.deps.choose(row.kind === "use" ? row.name : row.repo.fullName);
  }
}
