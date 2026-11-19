import type { CopyInFile } from "../changes/copy-in";
import { missingNotes } from "../changes/missing-notes";
import { leftOutKinds } from "../changes/left-out";
import { isHiddenPath, isRepoName, LISTED_FILE, normalizeFolder } from "../mapping";
import { proposeFolder } from "./folder";
import type { CopyInQuestion, FolderAnswer, FolderQuestion, SwitchQuestion } from "./folder-modals";
import { CHOOSE_A_REPOSITORY_FIRST, linked, SETUP_BAD_LINK, SETUP_SIGN_IN, SIGN_IN, STILL_WORKING } from "./words";

export interface PickerUi {

  pickRepository(): Promise<string | null>;

  confirmFolder(question: FolderQuestion | Promise<FolderQuestion>): Promise<FolderAnswer | null>;

  pickFolder(): Promise<string | null>;

  confirmSetup(repo: string): Promise<boolean>;

  confirmCopyIn(question: CopyInQuestion): Promise<boolean>;

  confirmSwitch(question: SwitchQuestion): Promise<boolean>;

  bringForward(): boolean;
}

export interface PickerDeps {
  ui: PickerUi;

  settings(): { repo: string; folder: string };

  apply(mapping: { repo: string; folder: string }): Promise<void>;

  repoFiles(repo: string): Promise<string[] | null>;

  listing?(repo: string): Promise<{ commit: string | null; files: ReadonlyMap<string, string> } | null>;

  vaultPaths(): string[];

  unsent(): Promise<number | null>;

  copyIn(files: readonly CopyInFile[], skipped?: readonly string[]): Promise<void>;
  signedIn(): boolean;
  signIn(): Promise<void>;
  notify(message: string): void;

  notifyWithAction(message: string, label: string, run: () => void): void;
}

export class RepoPicker {

  private busy = false;

  constructor(private readonly deps: PickerDeps) {}

  async chooseRepository(): Promise<void> {
    await this.alone(async () => {
      const repo = await this.deps.ui.pickRepository();
      if (repo !== null) await this.link(repo);
    });
  }

  async chooseFolder(): Promise<void> {
    await this.alone(async () => {
      const { repo } = this.deps.settings();
      if (!isRepoName(repo)) return this.deps.notify(CHOOSE_A_REPOSITORY_FIRST);
      const settled = await this.folderFor(repo);
      if (settled === null) return;
      await this.offerCopy(repo, settled);
      await this.deps.apply({ repo, folder: settled.folder });
    });
  }

  async setUp(repo: string | undefined): Promise<void> {
    await this.alone(async () => {
      if (repo === undefined || !isRepoName(repo)) return this.deps.notify(SETUP_BAD_LINK);
      if (!this.deps.signedIn()) return this.deps.notifyWithAction(SETUP_SIGN_IN, SIGN_IN, () => void this.deps.signIn());
      if (await this.deps.ui.confirmSetup(repo)) await this.link(repo);
    });
  }

  private async alone(step: () => Promise<void>): Promise<void> {
    if (this.busy) {
      if (!this.deps.ui.bringForward()) this.deps.notify(STILL_WORKING);
      return;
    }
    this.busy = true;
    try {
      await step();
    } finally {
      this.busy = false;
    }
  }

  private async link(repo: string): Promise<void> {
    const from = this.deps.settings().repo;

    const unsent = from !== repo && isRepoName(from) ? await this.deps.unsent() : 0;
    if ((unsent === null || unsent > 0) && !(await this.deps.ui.confirmSwitch({ from, to: repo, unsent }))) return;
    const settled = await this.folderFor(repo);
    if (settled === null) return;
    await this.offerCopy(repo, settled);
    await this.deps.apply({ repo, folder: settled.folder });
    this.deps.notify(linked(repo));
  }

  private async folderFor(repo: string): Promise<{ folder: string; files: string[] | null } | null> {

    const read = this.deps.repoFiles(repo).then((files) => {
      const hidden = files?.filter((path) => LISTED_FILE.test(path) && isHiddenPath(path)).length ?? 0;
      const documents = files?.filter((path) => LISTED_FILE.test(path) && !isHiddenPath(path)) ?? null;
      const proposal = files === null ? null : proposeFolder(files, this.deps.vaultPaths());
      const question: FolderQuestion = { repo, proposal, unread: files === null, total: documents?.length ?? 0, hidden };
      return { files, proposal, question };
    });
    let known: Promise<FolderQuestion> = read.then(({ question }) => question);
    for (;;) {
      const answer = await this.deps.ui.confirmFolder(known);
      if (answer === null) return null;
      const { files, proposal, question } = await read;

      known = Promise.resolve(question);
      if (answer === "whole") return { folder: "", files };
      if (answer === "use") return { folder: proposal === null ? "" : normalizeFolder(proposal.folder), files };
      const chosen = await this.deps.ui.pickFolder();
      if (chosen !== null) return { folder: normalizeFolder(chosen), files };
    }
  }

  private async offerCopy(repo: string, settled: { folder: string; files: string[] | null }): Promise<void> {
    if (settled.files === null) return;
    const { copy: missing, skipped } = missingNotes(settled.files, this.deps.vaultPaths(), [], settled.folder);
    const hidden = settled.files.filter((path) => LISTED_FILE.test(path) && isHiddenPath(path)).length;

    const held = new Set(this.deps.vaultPaths().map((path) => path.toLowerCase()));
    const every = (await this.deps.listing?.(repo).catch(() => null))?.files.keys() ?? settled.files;
    const leftOut = leftOutKinds([...every].filter((path) => !held.has((settled.folder === "" ? path : `${settled.folder}/${path}`).toLowerCase())));
    if (missing.length === 0 || !(await this.deps.ui.confirmCopyIn({ repo, count: missing.length, hidden, leftOut }))) return;
    await this.deps.copyIn(missing.map((path) => ({ path: settled.folder === "" ? path : `${settled.folder}/${path}`, doc: { repo, path } })), skipped);
  }
}
