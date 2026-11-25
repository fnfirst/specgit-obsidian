import type { Looked } from "../changes/model";
import { type DocumentRef, noteName } from "../mapping";
import type { DraftContext } from "./draft-inbound";
import { heldDeletesWords, trashedWords } from "./inbound";
import { BURST_FILES } from "./limits";
import { changeKey } from "./outbound";
import { DRAFT_SAID } from "./words";

export interface DeleteHost {
  wait(path: string): void;
  settled(path: string): void;
  forgetEnded(path: string): void;
  holdDeleted(looked: Looked, path: string, deletedAt: number): boolean;
  noteRemoved(path: string): void;
}

export class DraftDeletes {
  private readonly known = new Map<string, number>();
  private readonly toTrash = new Map<string, { sha: string; name: string }>();
  private readonly released = new Set<string>();
  private announced = 0;
  private readonly keptNow: string[] = [];

  constructor(
    private readonly ctx: DraftContext,
    private readonly host: DeleteHost,
  ) {}

  dropGone(looked: Looked): void {
    for (const path of [...this.toTrash.keys()]) if (!looked.files.has(path)) this.toTrash.delete(path);
  }

  async absentMain(path: string, doc: DocumentRef, sha: string, looked: Looked, kind: "settle" | "restore" | "end-own"): Promise<void> {
    const { ports } = this.ctx;
    const gone = this.known.has(path) ? { deletedAt: this.known.get(path)! } : await ports.wasDeleted(doc);
    if (!this.ctx.current()) return;
    if (gone === "unknown") {
      this.host.wait(path);
      return;
    }
    if (gone !== null) {
      this.known.set(path, gone.deletedAt);
      if (kind !== "end-own") this.toTrash.set(path, { sha, name: noteName(path) });
      else this.keep(looked, path, gone.deletedAt);
      return;
    }
    ports.agreed(path, null);
    this.ctx.clearOwnBlobs?.(path);
    this.host.forgetEnded(path);
    this.host.settled(path);
  }

  keep(looked: Looked, path: string, deletedAt: number): void {
    const { ports } = this.ctx;
    ports.agreed(path, null);
    this.ctx.clearOwnBlobs?.(path);
    this.host.forgetEnded(path);
    this.host.settled(path);
    const newlyTold = this.host.holdDeleted(looked, path, deletedAt);
    this.known.set(path, deletedAt);
    if (newlyTold) this.keptNow.push(noteName(path));
  }

  forget(path: string): void {
    this.known.delete(path);
  }

  tellKept(): void {
    for (const name of this.keptNow.splice(0)) this.ctx.ports.notify(DRAFT_SAID.deletedKept(name));
  }

  async flush(looked: Looked): Promise<number> {
    const { ports, state, activity } = this.ctx;
    if (this.toTrash.size === 0) return 0;
    for (const path of this.released) if (!this.toTrash.has(path)) this.released.delete(path);
    const asked = [...this.toTrash.keys()].filter((path) => !this.released.has(path));
    let allowed = [...this.toTrash.keys()];
    if (asked.length > BURST_FILES) {
      allowed = allowed.filter((path) => this.released.has(path));
      if (this.announced !== asked.length) {
        this.announced = asked.length;
        const release = (): void => {
          for (const path of asked) this.released.add(path);
          ports.heldDeletes?.(null);
          ports.lookAgain();
        };
        const words = heldDeletesWords(asked.length);
        if (ports.aware()) {
          ports.heldDeletes?.({ count: asked.length, move: release });
          ports.notify(words, { label: "Show them", run: () => ports.openStatus?.() }, { lasting: true });
        } else ports.notify(words, { label: "Move them to the trash", run: release });
      }
    }
    const names: string[] = [];
    for (const path of allowed) {
      if (!this.ctx.current()) break;
      const one = this.toTrash.get(path)!;
      activity.ownWrite(path);
      if (!(await ports.vault.trash(path, one.sha))) {
        activity.notWritten(path);
        this.toTrash.delete(path);
        this.host.wait(path);
        continue;
      }
      this.toTrash.delete(path);
      this.released.delete(path);
      this.host.noteRemoved(path);
      if (!looked.repo.has(path)) ports.forgetDelete(path);
      ports.agreed(path, null);
      this.ctx.clearOwnBlobs?.(path);
      this.host.forgetEnded(path);
      this.host.settled(path);
      const { data } = state;
      data.committed = data.committed.filter((key) => key !== changeKey({ kind: "new", path }) && !key.startsWith(`renamed|${path}|`));
      data.kept = data.kept.filter((one) => one !== path);
      if (data.deletedAt) delete data.deletedAt[path];
      names.push(one.name);
    }
    if (names.length > 0) ports.notify(trashedWords(names));
    return names.length;
  }
}
