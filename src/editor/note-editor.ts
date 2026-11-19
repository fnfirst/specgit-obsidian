import { Decoration, type DecorationSet, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { CaretLayer, type PeerCaret, redrawCarets } from "../cursors/carets";
import { onLines } from "../cursors/reading";
import { eolOf, toLf } from "../disk/line-endings";
import { changesBetween, unpublishedPlaces } from "../disk/merge";
import { cameInNow, changesIn, joinedWords } from "../disk/regions";
import { within } from "../patience";
import { type DocumentRef, docKey, noteName } from "../mapping";
import { lineageOf } from "../room/lineage";
import { joinFailedWords } from "../status";
import type { Room } from "../room/room";
import type { RoomSteps } from "../token-source";
import type { Stop } from "../room/transport";
import { Binding } from "./binding";
import { DELETED_WORDS } from "../deleted-words";
import { Join, type Outcome, TOO_LARGE_MESSAGE } from "./join";
import { isNoteEditor } from "./kind";
import { OwnWrites } from "./own-write";
import { NoteNotices } from "./note-notices";
import { type Phase, setDeleted, setReader, setPhase } from "./phase";
import { NoteRegistry } from "./registry";
import { Review } from "./review";
import type { EditorServices } from "./services";
import type { RoomUndo } from "./undo";

export const JOIN_PATIENCE_MS = 8_000;

const MAX_REBINDS = 3;

const SAID = {
  outOfStep: "Live editing stopped because this note got out of sync. Click Disconnect, then Connect Live.",
  paused: "specgit is updating this note, so you can't type in it for a moment.",
  stillPaused: "Reconnecting. Keep writing, and your changes are shared when it's back.",
  readOnly: "You can read this note but not change it. You don't have write access on GitHub.",
  diverged:
    "Some of your changes couldn't be shared, so this note is read-only. Click Disconnect, then Connect Live to add them.",
  declined: "Your note stays Local, as it was. Nothing was changed.",
  refused: (name: string, why: "riff" | "schema"): string =>
    why === "schema"
      ? `A change to ${name} couldn't be kept because specgit.com can't show it. It was put back.`
      : `A change to ${name} couldn't be kept because Obsidian can't show it. It was put back.`,
  mainMoved: "The published version has changed since you started. Open the Status tab to catch up.",
};

const DRAFT_AUTHOR_PATIENCE_MS = 5_000;

const later = (run: () => void): void => void Promise.resolve().then(run);

export class NoteEditor implements PluginValue {
  private path = "";

  private file: object | null = null;
  private ref: DocumentRef | null = null;
  private room: Room | null = null;

  private takenText: string | null = null;

  private refusedTold = false;
  private binding: Binding | null = null;
  private carets: CaretLayer | null = null;

  private textVersion = 0;
  private phase: Phase = "off";

  private stops: Array<() => void> = [];

  private watching: Array<() => void> = [];
  private patience: number | null = null;

  private readonly join: Join;

  private recorded: string | null = null;
  private reading = false;

  private rebinds = 0;

  private mayOnlyRead = false;

  private readonly review: Review;

  private announce = false;

  private answered: { key: string; steps: RoomSteps | null } | null = null;

  private readonly ownWrites: OwnWrites;
  private destroyed = false;

  private documentDeleted = false;

  constructor(
    private readonly view: EditorView,
    private readonly services: EditorServices,
    private readonly registry: NoteRegistry<NoteEditor>,
    private readonly told: NoteNotices = new NoteNotices(),
  ) {
    this.ownWrites = new OwnWrites(view);
    this.join = new Join(services, {
      path: () => this.path,
      ref: () => this.ref,
      destroyed: () => this.destroyed,
      again: () => this.bindIfReady(),
    });
    this.review = new Review(services, {
      name: () => noteName(this.path),
      room: () => this.room,
      text: () => this.view.state.doc.toString(),
      meet: (text, room) => this.join.meet(text, room),
    });
    const file = view.state.field(editorInfoField, false)?.file;
    if (!file) return;
    this.path = file.path;
    this.file = file;
    this.whenAttached(() => this.attach());
  }

  get decorations(): DecorationSet {
    return this.carets?.decorations ?? Decoration.none;
  }

  peers(): readonly PeerCaret[] {
    return this.carets?.peers ?? [];
  }

  history(): RoomUndo | null {
    return this.binding && this.room ? this.room.undo : null;
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.ownWrites.remember(update.state.doc);
      this.textVersion += 1;
    }
    this.binding?.update(update);
    this.carets?.update(update);

    if (this.phase === "local" && this.ref && !this.destroyed) this.matchChoice();
  }

  destroy(): void {
    this.destroyed = true;
    this.watching.splice(0).forEach((stop) => stop());
    this.leave();
  }

  tellReading(): void {
    const { reading } = this.services;
    if (!reading || !this.carets) return;
    reading.publish(this.path, onLines(this.view.state.doc, this.carets.peers), this.textVersion);
  }

  takeLead(): void {
    this.tellReading();
    later(() => this.bindIfReady());
  }

  private whenAttached(run: () => void, frames = 0): void {
    if (this.destroyed) return;
    if (this.view.dom.isConnected) {
      if (isNoteEditor(this.view.dom)) run();
    } else if (frames < 30) window.requestAnimationFrame(() => this.whenAttached(run, frames + 1));
  }

  private attach(): void {
    const { vault, connections } = this.services;
    this.watching.push(
      vault.onRename((from, to) => this.renamed(from, to)),
      vault.onDelete((path) => this.deleted(path)),
      vault.onModify((path) => path === this.path && this.saved()),
      connections.subscribe(() => this.matchChoice()),

      this.services.onMapping(() => this.placeAt(this.path)),
    );
    const ref = this.services.documentFor(this.path);
    if (ref) this.enter(ref);
  }

  private enter(ref: DocumentRef): void {
    this.ref = ref;
    this.registry.add(this.path, this);
    this.moveTo("local");
    this.services.gitBases.opened(this.path, ref);
    this.matchChoice();
  }

  private matchChoice(): void {
    const { ref } = this;
    if (this.destroyed || !ref || !this.showsItsNote()) return;
    const wanted = this.services.connections.wants(ref);
    if (wanted && this.phase === "local") this.connect(ref);
    else if (!wanted && this.phase !== "local" && this.phase !== "off") this.disconnect();
  }

  private showsItsNote(): boolean {
    const shown = this.view.state.field(editorInfoField, false)?.file;
    return shown === undefined || shown === null || shown === this.file;
  }

  private connect(ref: DocumentRef): void {
    this.announce = true;
    this.joinRoom(this.services.rooms.acquire(ref));
    this.waitForRoom();
    this.moveTo("joining");
    later(() => this.roomChanged());
  }

  private disconnect(): void {
    this.dropRoom(true);
    this.services.cameIn(this.path, null);
    if (this.mayOnlyRead) {
      this.mayOnlyRead = false;
      later(() => {
        if (!this.destroyed) this.view.dispatch({ effects: setReader.of(false) });
      });
    }
    this.moveTo("local");
  }

  private joinRoom(room: Room): void {
    this.room = room;
    this.rebinds = 0;
    this.carets = new CaretLayer(this.view, room.doc, room.awareness, room.tree, () => this.view.dispatch({ effects: redrawCarets.of(null) }));
    this.carets.listen(() => this.tellReading());
    this.tellReading();
    this.stops.push(room.subscribe(() => this.roomChanged()));
    this.stops.push(room.onBridgeRefused((why) => this.textPutBack(why)));
  }

  private textPutBack(why: "riff" | "schema"): void {
    if (this.refusedTold || !this.binding) return;
    this.refusedTold = true;
    this.services.notify(SAID.refused(noteName(this.path), why), this.path);
  }

  private dropRoom(now: boolean): void {
    this.review.withdraw();
    this.clearPatience();
    this.stops.splice(0).forEach((stop) => stop());
    this.unbind();
    this.carets?.destroy();
    this.carets = null;

    const other = this.registry.editorsOf(this.path).find((editor) => editor !== this && editor.carets !== null);
    if (other) other.tellReading();
    else this.services.reading?.publish(this.path, null);
    this.join.leave();
    const room = this.room;
    if (!room) return;
    this.room = null;
    this.services.rooms.release(room, now);
  }

  private leave(): void {
    this.dropRoom(false);
    if (!this.ref) return;
    this.ref = null;
    const next = this.registry.remove(this.path, this);
    if (this.registry.editorsOf(this.path).length === 0) {
      this.services.report(this.path, null);
      this.services.cameIn(this.path, null);
    }

    next?.takeLead();
  }

  private roomChanged(): void {
    const room = this.room;
    if (this.destroyed || !room) return;
    if (room.successor) return this.follow(room.successor);
    this.keepToAccess(room);
    if (room.stopped) return this.halt(room.stopped);

    if (room.state === "ready") later(() => this.meet());
    else if (room.state === "failed") this.giveUp();
    this.report();
  }

  private keepToAccess(room: Room): void {
    const reader = room.readOnly;
    if (reader === this.mayOnlyRead) return;
    this.mayOnlyRead = reader;
    later(() => {
      if (!this.destroyed) this.view.dispatch({ effects: setReader.of(reader) });
    });
    if (reader && this.leads()) this.services.notify(SAID.readOnly);
  }

  private halt(why: Stop): void {
    this.clearPatience();
    this.unbind();
    if (this.left) return;
    if (why === "diverged") this.lock(SAID.diverged);
    else if (why === "deleted") this.deletedOnSpecgit();
    else this.block(TOO_LARGE_MESSAGE);
  }

  private deletedOnSpecgit(): void {
    const text = this.view.state.doc.toString();
    const typed = this.takenText !== null && text !== this.takenText;

    for (const editor of this.registry.editorsOf(this.path)) editor.markDeleted();
    this.holdAll("locked");

    if (this.told.deletedShown(this.path)) return;
    const words = typed ? `${DELETED_WORDS.title}. ${DELETED_WORDS.typed}` : DELETED_WORDS.title;
    if (!this.services.notifyActions) return this.services.notify(words, this.path);
    const close = { label: DELETED_WORDS.close, run: () => this.services.closeNote?.(this.path) };
    const copy = {
      label: DELETED_WORDS.copy,
      run: () => {
        const done = (): void => void this.services.notify(DELETED_WORDS.copyFailed);
        try {
          void navigator.clipboard.writeText(text).catch(done);
        } catch {
          done();
        }
      },
    };

    this.told.deletedRaised(this.path, this.services.notifyActions(words, typed ? [copy, close] : [close], this.path, typed));
  }

  private markDeleted(): void {
    if (this.documentDeleted) return;
    this.documentDeleted = true;
    later(() => {
      if (!this.destroyed) this.view.dispatch({ effects: setDeleted.of(true) });
    });
  }

  tryTyping(): void {
    if (!this.documentDeleted || this.phase !== "locked") return;
    if (this.told.typingDue(this.path, Date.now())) this.services.notify(DELETED_WORDS.typing);
  }

  private meet(): void {
    if (this.destroyed || !this.room) return;
    if (!this.room.bridgeHere) return this.pause();
    this.clearPatience();
    this.bindIfReady();
  }

  private follow(next: Room): void {

    const key = this.ref ? docKey(this.ref) : null;
    const agreed = this.binding && this.room ? (this.room.vouched ?? "") : null;

    this.takenText = this.room ? (this.room.vouched ?? this.room.text.toJSON()) : null;

    const leaving = this.room?.steps ?? null;
    if (key !== null && this.services.ownRestarts.pending(key)) this.join.cutOffEither((room) => this.ownStep(key, leaving, room), agreed);
    else if (agreed !== null) this.join.cutOff(agreed, true);
    this.unbind();
    this.stops.splice(0).forEach((stop) => stop());
    this.carets?.destroy();
    this.joinRoom(next);
    this.waitForRoom();
    this.moveTo("joining");
    later(() => this.roomChanged());
  }

  private pause(): void {
    if (this.phase !== "live") return;
    if (this.binding && this.room) {
      this.join.cutOff(this.room.vouched ?? "", false);
      this.unbind();
      if (this.leads()) this.services.notify(SAID.paused);
    }
    this.moveTo("joining");
    this.waitForRoom();
  }

  private waitForRoom(): void {
    this.clearPatience();
    this.patience = window.setTimeout(() => this.giveUp(), JOIN_PATIENCE_MS);
  }

  private clearPatience(): void {
    if (this.patience !== null) window.clearTimeout(this.patience);
    this.patience = null;
  }

  private giveUp(): void {
    if (this.phase !== "joining") return;
    this.join.letOut(this.view.state.doc.toString());
    this.moveTo("offline");
    if (!this.leads()) return;
    const problem = this.room?.problem;

    if (problem) this.services.notify(joinFailedWords(problem), this.path);
    else if (this.room?.state === "ready") this.services.notify(SAID.stillPaused, this.path);
  }

  private bindIfReady(): void {
    const room = this.room;
    if (this.destroyed || !room?.bindable || this.left || this.binding || this.review.open) return;
    if (!this.leads()) return this.bindToLead(room);
    const outcome = this.join.meet(this.view.state.doc.toString(), room);
    switch (outcome.kind) {
      case "wait":
        return;
      case "lock":
        return this.lock(outcome.why);
      case "block":
        return this.block(outcome.why);
      case "apart":
        return this.stayLocal(outcome.why);
      case "review":
        return void this.chooseWhatToKeep(outcome);
      case "bind":
        return this.bindTo(room, outcome.text, outcome.notice, outcome.kept, outcome.git);
    }
  }

  private bindTo(room: Room, text: string, notice: string | null, kept = false, git?: string | null): void {
    const before = this.view.state.doc.toString();

    const roomBefore = toLf(room.text.toJSON());
    const binding = Binding.bind(this.view, room, () => later(() => this.lost(binding)), text);
    this.binding = binding;
    this.join.bound();

    if (this.answered !== null) this.services.ownRestarts.settle(this.answered.key, this.answered.steps, true);
    this.answered = null;
    this.setAll("live");
    this.services.joined?.(this.path);
    if (notice !== null) this.services.notify(notice);
    this.tellWhatCameIn(before, text, kept, git, roomBefore);

    for (const editor of this.registry.editorsOf(this.path)) if (editor !== this) later(() => editor.bindIfReady());
    void this.record();
  }

  private tellWhatCameIn(before: string, after: string, kept: boolean, git: string | null | undefined, room: string): void {
    if (!this.announce) return;
    this.announce = false;

    if (this.services.mainMoved?.(this.path)) this.services.notify(SAID.mainMoved);
    const shown = changesBetween(before, after);
    if (shown === null) return;

    const [binding, path, ref] = [this.binding, this.path, this.ref];
    const update = this.services.cameIn(path, shown, cameInNow(changesIn(shown), kept));
    if (!update || !ref) return;
    const patience = <T,>(read: Promise<T> | undefined, fallback: T): Promise<T> => within(read ?? Promise.resolve(fallback), DRAFT_AUTHOR_PATIENCE_MS, fallback).catch(() => fallback);
    void Promise.all([patience(this.services.draftBy?.(path), null), patience<string | null>(git !== undefined ? Promise.resolve(git) : this.services.gitCopy(ref).then((copy) => (copy === null ? null : toLf(copy))), null)]).then(([by, git]) => {
      if (this.destroyed || this.binding !== binding || binding === null) return;
      const split = unpublishedPlaces(shown, git, room);
      if (split !== null) update(joinedWords(split, by, kept));
    });
  }

  private async chooseWhatToKeep(outcome: Extract<Outcome, { kind: "review" }>): Promise<void> {
    const verdict = await this.review.ask(outcome);
    const room = this.room;

    if (verdict === "withdrawn" || !room) return;
    if (verdict === "closed") return this.stayLocal(SAID.declined);
    this.bindTo(room, verdict.applied, null);
  }

  private stayLocal(why: string): void {
    if (this.ref) this.services.connections.choose(this.ref, false, false);
    this.services.notify(why);
  }

  private bindToLead(room: Room): void {
    const lead = this.registry.editorsOf(this.path)[0];
    if (!lead?.binding) return this.moveTo(lead && lead.phase !== "off" && lead.phase !== "local" ? lead.phase : "joining");
    const binding = Binding.follow(this.view, room, () => later(() => this.lost(binding)));
    this.binding = binding;
    this.join.bound();
    this.moveTo("live");
  }

  private lost(from: Binding): void {
    if (this.destroyed || !this.room || this.binding !== from) return;
    this.join.cutOff(this.room.vouched ?? "", false);
    this.binding = null;
    if (++this.rebinds > MAX_REBINDS) return this.block(SAID.outOfStep);
    this.bindIfReady();
  }

  private block(why: string): void {
    this.holdAll("blocked");
    this.services.notify(why);
  }

  private unbind(): void {
    this.binding?.stop();
    this.binding = null;
  }

  private holdAll(phase: "blocked" | "locked"): void {
    this.setAll(phase);
    for (const editor of this.registry.editorsOf(this.path)) editor.unbind();
  }

  private lock(why: string): void {
    this.holdAll("locked");
    this.services.notify(why);
  }

  private saved(): void {

    this.ownWrites.takeSave(this.registry.editorsOf(this.path).map((editor) => editor.ownWrites));
    if (this.binding) this.rebinds = 0;
    void this.record();
  }

  private ownStep(key: string, leaving: RoomSteps | null, room: Room): string | null {
    const { ownRestarts } = this.services;
    const kept = ownRestarts.own(key, leaving, room.steps);
    if (kept !== null) this.announce = true;
    this.answered = { key, steps: room.steps };
    return kept;
  }

  private endsSoon(room: Room): boolean {
    if (!this.ref) return false;
    const key = docKey(this.ref);
    this.services.ownRestarts.settle(key, room.steps, false);
    return this.services.ownRestarts.pending(key);
  }

  private async record(): Promise<void> {
    const { binding, room } = this;

    if (!binding || !room || this.endsSoon(room) || !this.leads() || this.reading || this.view.state.doc.toString() === this.recorded) return;
    this.reading = true;
    try {
      const file = await this.services.vault.read(this.path);
      const text = this.view.state.doc.toString();

      if (file === null || room.name === null || this.binding !== binding || toLf(file) !== text || !room.acknowledged) return;
      if (this.endsSoon(room)) return;
      this.services.bases.write(this.path, { room: room.name, text, eol: eolOf(file), lineage: lineageOf(room.doc) });
      this.recorded = text;
    } catch { /* empty */ } finally {
      this.reading = false;
    }
  }

  private renamed(from: string, to: string): void {
    if (from === this.path) this.placeAt(to);
  }

  private placeAt(to: string): void {
    const from = this.path;
    const next = this.services.documentFor(to);
    if (this.ref && next && next.repo === this.ref.repo && next.path === this.ref.path) {
      if (from === to) return;

      this.registry.move(from, to);
      this.path = to;
      this.services.bases.move(from, to);
      this.services.report(from, null);
      this.report();
      return;
    }

    const old = this.ref;
    this.leave();

    this.join.forget();
    this.answered = null;
    if (old) this.services.connections.move(old, next);
    this.path = to;
    this.moveTo("off");
    if (next) this.enter(next);
  }

  private deleted(path: string): void {
    if (path !== this.path) return;
    const old = this.ref;
    this.leave();
    if (old) this.services.connections.forget(old);
    this.moveTo("off");
  }

  private get left(): boolean {
    return this.phase === "blocked" || this.phase === "locked";
  }

  private leads(): boolean {
    return this.registry.editorsOf(this.path)[0] === this;
  }

  private setAll(phase: Phase): void {
    for (const editor of this.registry.editorsOf(this.path)) editor.moveTo(phase);
  }

  private moveTo(phase: Phase): void {
    if (this.phase !== phase) {
      this.phase = phase;
      later(() => {
        if (!this.destroyed) this.view.dispatch({ effects: setPhase.of(phase) });
      });
    }
    this.report();
  }

  private report(): void {
    if (this.phase === "off") return;
    const { room } = this;
    this.services.report(this.path, { phase: this.phase, online: room?.online ?? false, readOnly: room?.readOnly ?? false, others: room?.others ?? 0, ...(room && room.alsoIn !== "" ? { alsoIn: room.alsoIn } : {}), ...(room && room.otherPeople.length ? { here: room.otherPeople } : {}), ...(this.phase === "offline" ? { why: this.whyNotLive(room) } : this.phase === "locked" && this.documentDeleted ? { why: "deleted" as const } : {}), ...(this.phase === "offline" && room?.retryAt != null ? { retryAt: room.retryAt } : {}) });
  }

  private whyNotLive(room: Room | null): "read-only" | "revoked" | "unreachable" {
    if (room?.readOnly) return "read-only";
    return room?.failureCode === "signed_out" ? "revoked" : "unreachable";
  }
}
