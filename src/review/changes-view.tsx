import type { Shown } from "../disk/regions";
import { ShownList } from "./parts";
import { type ChangesContext, changesWords } from "./words";

export function ChangesView({ shown, close, context = { kind: "came-in" } }: { shown: Shown[]; close: () => void;  context?: ChangesContext }) {
  const words = changesWords(context);
  return (
    <div class="specgit-review specgit-changes">
      <p class="specgit-review-intro">{words.intro}</p>
      <div class="specgit-review-body">
        <ShownList shown={shown} words={words} />
      </div>
      <footer class="specgit-review-footer">
        <div class="specgit-review-actions">
          <button type="button" class="specgit-button is-primary" onClick={close}>
            Close
          </button>
        </div>
      </footer>
    </div>
  );
}
