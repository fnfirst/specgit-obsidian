import { Budget, withoutFinalBreaks } from "../disk/diff";
import { toLf } from "../disk/line-endings";
import { reconcile, roomIsUnwritten } from "../disk/reconcile";
import type { Region } from "../disk/regions";
import { type DocumentRef, docKey } from "../mapping";
import { GIT_COPY_PATIENCE_MS, within } from "../patience";
import { holdsLineage } from "../room/lineage";
import type { Room } from "../room/room";
import type { EditorServices } from "./services";

const MERGE_MS = 400;

export const MAX_NOTE_BYTES = 1024 * 1024;

export const TOO_LARGE_MESSAGE = "This note is too large to edit live. Split it into smaller notes to edit it live.";

const SAID = {
  startedOver: "The live note was reset while you were away. Your changes were added to it.",
  locked: "Couldn't connect this note safely, so it's read-only. Click Disconnect, then Connect Live.",
  emptyRoom: "The live note is empty and you can only read it, so this note isn't live. Your note wasn't changed.",
  apart: "You can only read this note, and yours differs from the live note, so it stays Local.",
};

const encoder = new TextEncoder();

function tooLarge(text: string): boolean {
  return text.length > MAX_NOTE_BYTES || (text.length * 3 > MAX_NOTE_BYTES && encoder.encode(text).length > MAX_NOTE_BYTES);
}

interface Apart {
  readonly base: string | null;
  readonly startedOver: boolean;
  readonly fromGit: boolean;
}

const NO_BASE: Apart = { base: null, startedOver: false, fromGit: false };

export interface Snapshot {
  mine: string;
  theirs: string;
}

export type Outcome =
  | { kind: "wait" }
  | { kind: "block"; why: string }
  | { kind: "lock"; why: string }
  | { kind: "apart"; why: string }
  | { kind: "review"; regions: Region[]; fromBase: boolean; snapshot: Snapshot; base: string | null }
  | { kind: "bind"; text: string; notice: string | null; kept: boolean; base: string | null; git?: string | null };

const WAIT: Outcome = { kind: "wait" };

export interface JoinHost {
  path(): string;
  ref(): DocumentRef | null;
  destroyed(): boolean;
  again(): void;
}

export class Join {
  private apart: Apart | null = null;
  private either: { kept: (room: Room) => string | null; theirs: Apart | null } | null = null;
  private git: string | null | undefined = undefined;
  private settling = false;
  private letOutWith: string | null = null;

  constructor(
    private readonly services: EditorServices,
    private readonly host: JoinHost,
  ) {}

  cutOff(base: string, startedOver: boolean): void {
    this.apart = { base, startedOver, fromGit: false };
  }

  cutOffEither(kept: (room: Room) => string | null, agreed: string | null): void {
    this.either = { kept, theirs: agreed === null ? null : { base: agreed, startedOver: true, fromGit: false } };
  }

  forget(): void {
    this.apart = null;
    this.either = null;
    this.git = undefined;
  }

  letOut(text: string): void {
    this.letOutWith = text;
  }

  leave(): void {
    this.git = undefined;
  }

  bound(): void {
    this.apart = null;
    this.either = null;
    this.letOutWith = null;
    this.git = undefined;
  }

  meet(editor: string, room: Room): Outcome {
    if (this.settling) return WAIT;
    const apart = this.apartFrom(room);
    if (apart === "unreadable") return { kind: "lock", why: SAID.locked };
    const roomText = toLf(room.text.toJSON());
    if (tooLarge(editor) || tooLarge(roomText)) return { kind: "block", why: TOO_LARGE_MESSAGE };
    if (room.readOnly && editor !== "" && roomIsUnwritten(roomText, editor)) return { kind: "block", why: SAID.emptyRoom };
    const meeting = { editor, room: roomText, base: apart.base, emptied: editor === "" && !!this.letOutWith, git: this.git, baseIsGit: apart.fromGit, readOnly: room.readOnly };
    const joined = reconcile(meeting, new Budget(MERGE_MS));
    switch (joined.kind) {
      case "needs-git": {
        const recording = this.services.gitBases.underway(this.host.path());
        void (recording ? this.settle(() => recording) : this.askGit());
        return WAIT;
      }
      case "apart":
        return { kind: "apart", why: SAID.apart };
      case "review":
        return { kind: "review", regions: joined.regions, fromBase: joined.fromBase, snapshot: { mine: editor, theirs: roomText }, base: joined.fromBase ? apart.base : null };
      case "text": {
        const base =
          apart.base ??
          (withoutFinalBreaks(editor) === withoutFinalBreaks(roomText)
            ? roomText
            : !roomIsUnwritten(roomText, editor) && this.git != null && withoutFinalBreaks(editor) === withoutFinalBreaks(this.git)
              ? this.git
              : null);
        return {
          kind: "bind",
          text: joined.text,
          notice: apart.startedOver && joined.text !== roomText ? SAID.startedOver : null,
          kept: apart.base !== null && withoutFinalBreaks(editor) !== withoutFinalBreaks(apart.base) && joined.text !== roomText,
          base,
          ...(this.git !== undefined ? { git: this.git } : {}),
        };
      }
    }
  }

  private askGit(): Promise<void> {
    const ref = this.host.ref();
    return this.settle(async () => {
      if (!ref) return;
      const held = await within(this.services.gitCopy(ref), GIT_COPY_PATIENCE_MS, null);
      if (!this.host.destroyed() && this.host.ref() === ref) this.git = held === null ? null : toLf(held);
    });
  }

  private async settle(step: () => Promise<void>): Promise<void> {
    this.settling = true;
    try {
      await step();
    } finally {
      this.settling = false;
    }
    this.host.again();
  }

  private apartFrom(room: Room): Apart | "unreadable" {
    if (this.either) {
      const { kept, theirs } = this.either;
      this.either = null;
      const base = kept(room);
      if (base !== null) this.apart = { base, startedOver: false, fromGit: false };
      else if (theirs) this.apart = theirs;
    }
    if (this.apart) return this.apart;
    const read = this.services.bases.read(this.host.path());
    if (read.status === "unreadable") return "unreadable";
    if (read.status === "none") return NO_BASE;
    const { base } = read;
    if (base.room === null) {
      const ref = this.host.ref();
      return ref && base.doc === docKey(ref) ? { base: base.text, startedOver: false, fromGit: true } : NO_BASE;
    }
    if (base.room !== room.name) return NO_BASE;
    return { base: base.text, startedOver: !holdsLineage(room.doc, base.lineage), fromGit: false };
  }
}
