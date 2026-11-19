import { EmptyState } from "../brand/parts";
import { GIVE_ACCESS_LABEL, notInstalledWords } from "../changes/words";

export interface ChangesActions {

  openNote(path: string, event?: MouseEvent | KeyboardEvent): void;
  openUrl(url: string): void;
  openInSpecgit(path: string): void;

  isLive(path: string): boolean;

  repo(): string;

  owner(): string;

  folder(): string;

  giveAccess(): void;

  copyIn?(): Promise<void>;

  join?(path: string): void;
  addToMyNote?(path: string): void;

  offered?(): readonly string[];
  addOffered?(): void;
}

export function NotInstalled({ actions }: { actions: ChangesActions }) {
  return (
    <div class="specgit-welcome" data-testid="not-installed">
      <EmptyState icon="key-round" role="status">
        {notInstalledWords(actions.owner())}
      </EmptyState>
      <button type="button" class="specgit-button is-primary" onClick={() => actions.giveAccess()}>
        {GIVE_ACCESS_LABEL}
      </button>
    </div>
  );
}
