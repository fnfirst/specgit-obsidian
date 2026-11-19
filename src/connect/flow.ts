import type { Dialogs } from "../changes/flow-deps";
import { type DocumentRef, isRepoFile, noteName, type Place } from "../mapping";
import { placeWords } from "../pick/words";
import { isNotLive, NOT_CONNECTED, type StatusBoard } from "../status";
import type { Connections } from "./connections";

export interface FlowDeps {

  placeOf(path: string): Place;

  linked(): { repo: string; folder: string };
  connections: Connections;
  status: StatusBoard;
  signedIn(): boolean;

  ensureOpen(path: string): Promise<void>;
  notify(message: string): void;

  noteUrl(doc: DocumentRef): string;
  openUrl(url: string): void;
  copyText(text: string): Promise<void>;

  disconnected?(): void;

  choose: Dialogs["choose"];

  hasUnsentEdits(path: string): boolean;
}

export const NOT_STARTED_MS = 15_000;

export const OPEN_ASKS = {
  title: (name: string): string => `Open ${name} in specgit?`,
  description: "specgit.com shows the GitHub version. Connect Live first to see your latest changes there.",
  connect: "Connect and open",
  github: "Open GitHub's version",
} as const;

const SAID = {
  signedOut: "Sign in to specgit to connect this note.",
  copied: "Link copied.",
  notCopied: "Couldn't copy the link. Try again, or open the note in specgit and copy its address from there.",
};

type Ended = "live" | "refused" | "withdrawn" | "failed";

export class NoteFlows {
  constructor(private readonly deps: FlowDeps) {}

  async connect(path: string): Promise<Ended> {
    const place = this.deps.placeOf(path);

    if (place.kind !== "note") return this.refuse(placeWords(place, this.deps.linked()));
    const { doc } = place;
    if (!this.deps.signedIn()) return this.refuse(SAID.signedOut);
    if (this.deps.status.phaseOf(path) === "live") return "live";
    await this.deps.ensureOpen(path);
    return new Promise<Ended>((resolve) => {
      const end = (ended: Ended): void => {
        stopStatus();
        stopChoice();
        window.clearTimeout(timer);
        resolve(ended);
      };
      const settle = (): void => {
        const phase = this.deps.status.phaseOf(path);
        if (phase === "live") end("live");
        else if (!this.deps.connections.wants(doc)) end("withdrawn");
        else if (isNotLive(phase)) end("failed");
      };
      const stopStatus = this.deps.status.subscribe(settle);
      const stopChoice = this.deps.connections.subscribe(settle);

      const timer = window.setTimeout(() => {
        if (this.deps.status.phaseOf(path) === "local") end("failed");
      }, NOT_STARTED_MS);
      this.deps.connections.choose(doc, true);
    });
  }

  disconnect(path: string): void {
    const place = this.deps.placeOf(path);
    if (place.kind !== "note") return;
    this.deps.connections.choose(place.doc, false);

    this.deps.disconnected?.();
  }

  async openInSpecgit(path: string): Promise<void> {
    const place = this.deps.placeOf(path);
    if (!isRepoFile(place)) {
      this.refuse(placeWords(place, this.deps.linked()));
      return;
    }

    if (place.kind === "note" && this.deps.status.phaseOf(path) === "local" && this.deps.hasUnsentEdits(path)) {
      const connect = await this.deps.choose({ title: OPEN_ASKS.title(noteName(path)), description: OPEN_ASKS.description, confirmLabel: OPEN_ASKS.connect, cancelLabel: OPEN_ASKS.github });

      if (connect === null) return;
      if (connect) {
        const ended = await this.connect(path);

        if (ended === "failed" && !this.deps.status.wasTold(path)) this.deps.notify(NOT_CONNECTED);

        if (ended !== "live") return;
      }
    }
    this.deps.openUrl(this.deps.noteUrl(place.doc));
  }

  async copyLink(path: string): Promise<void> {
    const place = this.deps.placeOf(path);
    if (!isRepoFile(place)) {
      this.refuse(placeWords(place, this.deps.linked()));
      return;
    }
    try {
      await this.deps.copyText(this.deps.noteUrl(place.doc));
      this.deps.notify(SAID.copied);
    } catch {
      this.deps.notify(SAID.notCopied);
    }
  }

  private refuse(why: string): Ended {
    this.deps.notify(why);
    return "refused";
  }
}
