import { Budget, diffTokens, withoutFinalBreaks } from "../disk/diff";
import { toLf } from "../disk/line-endings";
import { reconcile, roomIsUnwritten } from "../disk/reconcile";
import type { Region } from "../disk/regions";
import { type DocumentRef, docKey } from "../mapping";
import { GIT_COPY_PATIENCE_MS, SENT_BASE_PATIENCE_MS, withDeadline } from "../patience";
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

function roomDroppedBase(base: string, room: string, budget: Budget): boolean {
  const b = withoutFinalBreaks(base);
  const r = withoutFinalBreaks(room);
  if (b === r) return false;
  const hunks = diffTokens(b.split("\n"), r.split("\n"), budget);
  return budget.over || hunks.some((hunk) => hunk.aTo > hunk.aFrom);
}

interface Apart {
  readonly base: string | null;
  readonly startedOver: boolean;
  readonly fromGit: boolean;
  readonly fromStore?: boolean;
  readonly at?: number;
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
  private gitAbort: AbortController | null = null;
  private sent: string | null | undefined = undefined;
  private sentEpoch = 0;
  private sentAbort: AbortController | null = null;
  private settling = false;
  private letOutWith: string | null = null;
  private joiningFrom: string | null = null;

  constructor(
    private readonly services: EditorServices,
    private readonly host: JoinHost,
  ) {}

  enterJoining(editableText: string | null): void {
    this.joiningFrom = editableText === null ? null : toLf(editableText);
  }

  private cancelSent(): void {
    this.sent = undefined;
    this.sentEpoch++;
    this.sentAbort?.abort();
    this.sentAbort = null;
  }

  private cancelGit(): void {
    this.git = undefined;
    this.gitAbort?.abort();
    this.gitAbort = null;
  }

  cutOff(base: string, startedOver: boolean): void {
    this.apart = { base, startedOver, fromGit: false };
    this.cancelSent();
  }

  cutOffEither(kept: (room: Room) => string | null, agreed: string | null): void {
    this.either = { kept, theirs: agreed === null ? null : { base: agreed, startedOver: true, fromGit: false } };
    this.cancelSent();
  }

  forget(): void {
    this.apart = null;
    this.either = null;
    this.joiningFrom = null;
    this.cancelGit();
    this.cancelSent();
  }

  letOut(text: string): void {
    this.letOutWith = text;
  }

  leave(): void {
    this.joiningFrom = null;
    this.cancelGit();
    this.cancelSent();
  }

  bound(): void {
    this.apart = null;
    this.either = null;
    this.letOutWith = null;
    this.joiningFrom = null;
    this.cancelGit();
    this.cancelSent();
  }

  meet(editor: string, room: Room): Outcome {
    if (this.settling) return WAIT;
    const apart = this.apartFrom(room);
    if (apart === "unreadable") return { kind: "lock", why: SAID.locked };
    const roomText = toLf(room.text.toJSON());
    if (tooLarge(editor) || tooLarge(roomText)) return { kind: "block", why: TOO_LARGE_MESSAGE };
    if (room.readOnly && editor !== "" && roomIsUnwritten(roomText, editor)) return { kind: "block", why: SAID.emptyRoom };
    const emptied = editor === "" && (!!this.letOutWith || (this.joiningFrom !== null && this.joiningFrom !== ""));
    const differs = !(editor === "" && !emptied) && editor !== roomText && withoutFinalBreaks(editor) !== withoutFinalBreaks(roomText) && !roomIsUnwritten(roomText, editor);
    const joiningMatchedRoom = apart.base === null && this.joiningFrom !== null && withoutFinalBreaks(roomText) === withoutFinalBreaks(this.joiningFrom);
    const unverifiedRestartBase = apart.fromStore === true && apart.startedOver && apart.base !== null && differs;
    if (
      !joiningMatchedRoom &&
      this.sent === undefined &&
      this.services.sentBase !== undefined &&
      differs &&
      (apart.base === null || apart.fromGit || apart.at !== undefined)
    ) {
      const ref = this.host.ref();
      if (!ref) this.sent = null;
      else {
        const since = apart.fromGit || apart.base === null || unverifiedRestartBase ? undefined : apart.at;
        const abort = new AbortController();
        const sync = { asked: false };
        const pending = withDeadline<string | null>(
          (signal) => {
            const read = this.services.sentBase!(this.host.path(), ref, since, signal);
            if (read === null) return Promise.resolve(null);
            sync.asked = true;
            return read;
          },
          SENT_BASE_PATIENCE_MS,
          null,
          abort.signal,
        );
        if (!sync.asked) {
          abort.abort();
          this.sent = null;
        } else {
          this.sentAbort?.abort();
          this.sentAbort = abort;
          void this.askSentBase(ref, pending, abort);
          return WAIT;
        }
      }
    }
    let safeApart: Apart = apart;
    if ((this.sent === null || this.sent === undefined) && unverifiedRestartBase && apart.base !== null) {
      if (this.git === undefined) {
        const recording = this.services.gitBases.underway(this.host.path());
        void (recording ? this.settle(() => recording) : this.askGit());
        return WAIT;
      }
      const rejectRestartBase =
        this.git !== null
          ? withoutFinalBreaks(this.git) !== withoutFinalBreaks(apart.base)
          : withoutFinalBreaks(editor) === withoutFinalBreaks(apart.base) || roomDroppedBase(apart.base, roomText, new Budget(MERGE_MS));
      if (rejectRestartBase) safeApart = { base: null, startedOver: true, fromGit: false };
    }
    if (joiningMatchedRoom) {
      safeApart = { base: roomText, startedOver: false, fromGit: false };
    } else if (
      safeApart.base === null &&
      (this.sent === null || this.sent === undefined) &&
      this.joiningFrom !== null &&
      roomText !== "" &&
      withoutFinalBreaks(this.joiningFrom).startsWith(withoutFinalBreaks(roomText))
    ) {
      if (this.git === undefined) {
        const recording = this.services.gitBases.underway(this.host.path());
        void (recording ? this.settle(() => recording) : this.askGit());
        return WAIT;
      }
      if (this.git === null) safeApart = { base: roomText, startedOver: false, fromGit: false };
    }
    const effective: Apart = this.sent !== null && this.sent !== undefined ? { base: this.sent, startedOver: false, fromGit: false } : safeApart;
    const meeting = { editor, room: roomText, base: effective.base, emptied, git: this.git, baseIsGit: effective.fromGit, readOnly: room.readOnly, source: "room" as const };
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
        return { kind: "review", regions: joined.regions, fromBase: joined.fromBase, snapshot: { mine: editor, theirs: roomText }, base: joined.fromBase ? effective.base : null };
      case "text": {
        const base =
          effective.base ??
          (withoutFinalBreaks(editor) === withoutFinalBreaks(roomText)
            ? roomText
            : !roomIsUnwritten(roomText, editor) && this.git != null && withoutFinalBreaks(editor) === withoutFinalBreaks(this.git)
              ? this.git
              : null);
        return {
          kind: "bind",
          text: joined.text,
          notice: effective.startedOver && joined.text !== roomText ? SAID.startedOver : null,
          kept: effective.base !== null && withoutFinalBreaks(editor) !== withoutFinalBreaks(effective.base) && joined.text !== roomText,
          base,
          ...(this.git !== undefined ? { git: this.git } : {}),
        };
      }
    }
  }

  private askSentBase(ref: DocumentRef, pending: Promise<string | null>, abort: AbortController): Promise<void> {
    const epoch = this.sentEpoch;
    return this.settle(async () => {
      try {
        const held = await pending;
        if (!abort.signal.aborted && !this.host.destroyed() && this.host.ref() === ref && epoch === this.sentEpoch) {
          this.sent = held === null ? null : toLf(held);
        }
      } finally {
        if (this.sentAbort === abort) this.sentAbort = null;
      }
    });
  }

  private askGit(): Promise<void> {
    const ref = this.host.ref();
    return this.settle(async () => {
      if (!ref) return;
      const abort = new AbortController();
      this.gitAbort?.abort();
      this.gitAbort = abort;
      try {
        const held = await withDeadline((signal) => this.services.gitCopy(ref, signal), GIT_COPY_PATIENCE_MS, null, abort.signal);
        if (!abort.signal.aborted && !this.host.destroyed() && this.host.ref() === ref) this.git = held === null ? null : toLf(held);
      } finally {
        if (this.gitAbort === abort) this.gitAbort = null;
      }
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
    return { base: base.text, startedOver: !holdsLineage(room.doc, base.lineage), fromGit: false, fromStore: true, at: base.at };
  }
}
