import type { Board } from "../board";
import { changesIn, type Shown } from "../disk/regions";
import { type DocumentRef, docKey, type FileKind, noteName, type PathKind, type Place } from "../mapping";
import { IDLE_AFTER_MS, IDLE_FOCUSED_AFTER_MS, type PollSignals } from "../shared/review-flow";
import type { NoteStatus, StatusBoard } from "../status";

export type TabId = "status" | "comments";

export const PEOPLE_FRESH_MS = 25_000;

export interface PanelState {
  note: { path: string; name: string } | null;
  file: { path: string; name: string; kind: FileKind } | null;
  elsewhere: PathKind | null;
  signedIn: boolean;
  mapped: boolean;
  repo: string;
  folder: string;
  stay: boolean;
  status: NoteStatus | null;
  people: number | null;
  cameIn: number | null;
}

export interface PanelDeps {
  activeNote(): string | null;
  placeOf(path: string): Place;
  status: StatusBoard;
  cameIn: Board<Shown[]>;
  signedIn(): boolean;
  mapped(): boolean;
  repo?(): string;
  folder?(): string;
  stayConnected(): boolean;
  peopleIn(doc: DocumentRef): Promise<number | null>;
  now?: () => number;
  signals?: PollSignals;
}

function samePanelState(a: PanelState, b: PanelState): boolean {
  return (
    a.signedIn === b.signedIn &&
    a.mapped === b.mapped &&
    a.repo === b.repo &&
    a.folder === b.folder &&
    a.stay === b.stay &&
    a.elsewhere === b.elsewhere &&
    a.status === b.status &&
    a.people === b.people &&
    a.cameIn === b.cameIn &&
    (a.note === b.note || (a.note !== null && b.note !== null && a.note.path === b.note.path && a.note.name === b.note.name)) &&
    (a.file === b.file || (a.file !== null && b.file !== null && a.file.path === b.file.path && a.file.name === b.file.name && a.file.kind === b.file.kind))
  );
}

export class PanelModel {
  private current: PanelState;
  private boardRevision: number;
  private readonly listeners = new Set<() => void>();
  private readonly asked = new Map<string, { people: number | null; at: number }>();
  private readonly asking = new Set<string>();
  private open = 0;
  private stopShown: (() => void) | null = null;
  private tabId: TabId = "status";
  private readonly now: () => number;

  constructor(private readonly deps: PanelDeps) {
    this.now = deps.now ?? Date.now;
    this.boardRevision = this.readBoardRevision();
    this.current = this.read();
  }

  private readBoardRevision(): number {
    return typeof this.deps.status.revision === "function" ? this.deps.status.revision() : -1;
  }

  state(): PanelState {
    return this.current;
  }

  tab = (): TabId => this.tabId;

  selectTab = (tab: TabId): void => {
    if (tab === this.tabId) return;
    this.tabId = tab;
    this.listeners.forEach((listener) => listener());
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attach(): () => void {
    const wasClosed = this.open === 0;
    this.open++;
    if (wasClosed && this.deps.signals) {
      this.stopShown = this.deps.signals.onShown(() => this.askPeople());
    }
    this.update();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.open = Math.max(0, this.open - 1);
      if (this.open === 0) {
        this.stopShown?.();
        this.stopShown = null;
      }
    };
  }

  update(): void {
    const next = this.read();
    const boardRevision = this.readBoardRevision();
    if (boardRevision !== this.boardRevision || !samePanelState(this.current, next)) {
      this.boardRevision = boardRevision;
      this.current = next;
      this.listeners.forEach((listener) => listener());
    }
    this.askPeople();
  }

  askPeople(): void {
    const { note, status } = this.current;
    if (this.open === 0 || !note || !this.current.signedIn || (status && status.phase !== "local")) return;
    const { signals } = this.deps;
    if (signals) {
      if (signals.hidden()) return;
      const limit = signals.focused?.() ? IDLE_FOCUSED_AFTER_MS : IDLE_AFTER_MS;
      if (signals.now() - signals.lastActivityAt() >= limit) return;
    }
    const place = this.deps.placeOf(note.path);
    if (place.kind !== "note") return;
    const key = docKey(place.doc);
    const last = this.asked.get(key);
    if (this.asking.has(key) || (last && this.now() - last.at < PEOPLE_FRESH_MS)) return;
    this.asking.add(key);
    void this.deps.peopleIn(place.doc).then((people) => {
      this.asking.delete(key);
      this.asked.set(key, { people, at: this.now() });
      this.update();
    });
  }

  private read(): PanelState {
    const path = this.deps.activeNote();
    const vault: PanelState = {
      note: null,
      file: null,
      elsewhere: null,
      signedIn: this.deps.signedIn(),
      mapped: this.deps.mapped(),
      repo: this.deps.repo?.() ?? "",
      folder: this.deps.folder?.() ?? "",
      stay: this.deps.stayConnected(),
      status: null,
      people: null,
      cameIn: null,
    };
    if (path === null) return vault;
    const place = this.deps.placeOf(path);
    switch (place.kind) {
      case "unlinked":
        return vault;
      case "outside":
        return { ...vault, elsewhere: place.file };
      case "board":
      case "base":
      case "other":
        return { ...vault, file: { path, name: noteName(path), kind: place.kind } };
      case "note": {
        const status = this.deps.status.get(path) ?? null;
        const shown = this.deps.cameIn.get(path);
        const people = status && status.phase !== "local" ? status.others : (this.asked.get(docKey(place.doc))?.people ?? null);
        return { ...vault, note: { path, name: noteName(path) }, status, people, cameIn: shown ? changesIn(shown) : null };
      }
    }
  }
}
