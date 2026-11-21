import type { App } from "obsidian";
import { render, type VNode } from "preact";
import { SpecgitModal } from "../brand/modal";
import type { Shown } from "../disk/regions";
import type { ReviewRequest } from "../editor/services";
import { ChangesView } from "./changes-view";
import { ConflictReview } from "./conflict-review";
import { type ChangesContext, changesWords, MERGED_REVIEW } from "./words";

abstract class ScreenModal extends SpecgitModal {
  constructor(app: App, title: string) {
    super(app);
    this.setTitle(title);
    this.modalEl.addClass("is-wide");
  }

  protected abstract screen(): VNode;

  override onOpen(): void {
    render(this.screen(), this.contentEl);
  }

  override onClose(): void {
    render(null, this.contentEl);
  }
}

class ConflictModal extends ScreenModal {
  constructor(
    app: App,
    private readonly request: ReviewRequest,
    private readonly done: (text: string | null) => void,
  ) {
    super(app, request.merged ? MERGED_REVIEW.title : `Choose what to keep in ${request.name}`);
  }

  protected screen(): VNode {
    const { request } = this;
    return (
      <ConflictReview
        regions={request.regions}
        merged={request.merged}
        fromBase={request.fromBase}
        other={request.other}
        settle={request.settle}
        apply={(text) => {
          this.done(text);
          this.close();
        }}
        cancel={() => this.close()}
      />
    );
  }

  override onClose(): void {
    super.onClose();
    this.done(null);
  }
}

export function chooseWhatToKeep(app: App, request: ReviewRequest): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new ConflictModal(app, request, resolve);
    request.signal.addEventListener("abort", () => modal.close());
    modal.open();
  });
}

class ChangesModal extends ScreenModal {
  constructor(
    app: App,
    private readonly shown: Shown[],
    private readonly context: ChangesContext,
    private readonly closed?: () => void,
  ) {
    super(app, changesWords(context).title);
  }

  override onClose(): void {
    super.onClose();
    this.closed?.();
  }

  protected screen(): VNode {
    return <ChangesView shown={this.shown} context={this.context} close={() => this.close()} />;
  }
}

export function showChanges(app: App, shown: Shown[], context: ChangesContext = { kind: "came-in" }, closed?: () => void): { close: () => void } {
  const modal = new ChangesModal(app, shown, context, closed);
  modal.open();
  return modal;
}
