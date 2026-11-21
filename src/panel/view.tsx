import { ItemView, Scope, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { MARK_ICON } from "../brand/mark";
import { sendFrom } from "../comments/send-key";
import type { PanelModel } from "./model";
import { Panel, type PanelActions, type PanelComments } from "./panel";

export const PANEL_TYPE = "specgit-panel";

const PEOPLE_POLL_MS = 30_000;

export class PanelView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly model: PanelModel,
    private readonly actions: PanelActions,
    private readonly comments: PanelComments,
  ) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "Enter", () => (sendFrom(this.contentEl.doc.activeElement) ? false : undefined));
  }

  getViewType(): string {
    return PANEL_TYPE;
  }

  getDisplayText(): string {
    return "specgit";
  }

  override getIcon(): string {
    return MARK_ICON;
  }

  override onOpen(): Promise<void> {
    this.register(this.model.attach());
    this.registerInterval(window.setInterval(() => this.model.askPeople(), PEOPLE_POLL_MS));
    render(<Panel model={this.model} actions={this.actions} comments={this.comments} />, this.contentEl);
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    render(null, this.contentEl);
    return Promise.resolve();
  }
}
