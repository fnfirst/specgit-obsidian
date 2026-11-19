import { toLf } from "../disk/line-endings";
import { DELETED_WORDS } from "../deleted-words";
import { noteName } from "../mapping";
import { deletedAtOf } from "../review/review-api";
import type { BranchFile } from "../auth/git-copy";
import { COULDNT_FINISH } from "../shared/review-flow";
import { BRANCH_MOVED_AGAIN, failure, MOVED_ATTEMPTS, type Sent, UNREADABLE } from "./flow-helpers";
import { behindOf, levelWith, sendThroughBranch } from "./branch-send";
import type { FlowDeps } from "./flow-deps";
import type { ChangeRow } from "./model";
import { mergedWith } from "./note-merge";
import { inRepoEndings } from "./repo-endings";
import type { ReadBacks } from "./read-back";
import type { SentMemory } from "./sent-memory";

export interface MemberHost {
  readonly deps: FlowDeps;
  readonly backs: ReadBacks;
  readonly memory: SentMemory;
  send(row: ChangeRow): Promise<Sent>;
}

export interface SyncedAll {
  ok: true;
  expectMain: null;
  same: readonly string[];
}

export class MemberSync {
  constructor(private readonly host: MemberHost) {}

  async syncAll(rows: readonly ChangeRow[], group: string): Promise<Sent | SyncedAll> {
    const same: string[] = [];
    for (const row of rows) {
      if (row.change.kind === "deleted") return { ok: false, message: `${noteName(row.change.path)} was deleted here after it joined ${group}. Take it out of the group first, or restore it.` };
      const sent = await this.syncMember(row);
      if (!sent.ok) return sent;
      if (sent.unchanged) same.push(row.change.path);
    }
    return { ok: true, expectMain: null, same };
  }

  private async syncMember(row: ChangeRow): Promise<Sent> {

    for (let attempt = 1; ; attempt++) {
      const sent = await this.syncMemberOnce(row);
      if (sent.ok || "held" in sent || !sent.moved) return sent;
      if (attempt >= MOVED_ATTEMPTS) return { ok: false, message: BRANCH_MOVED_AGAIN(noteName(row.change.path)) };
    }
  }

  private async syncMemberOnce(row: ChangeRow): Promise<Sent> {
    const { change, doc } = row;
    const { deps, memory } = this.host;
    const name = noteName(change.path);
    const text = await deps.readText(change.path);
    if (text === null) return { ok: false, message: COULDNT_FINISH };

    const status = row.review ?? (await deps.review.status(doc));
    const there: BranchFile = status === null ? { kind: "unreadable" } : status.reviewBranch === null ? { kind: "absent" } : await deps.branchFile(doc, status.reviewBranch);
    if (there.kind === "unreadable") return { ok: false, message: UNREADABLE(name) };
    if (there.kind === "absent") return this.host.send(row);
    if (there.text === text) {
      await memory.remember(change.path, text, undefined, text);
      return { ok: true, expectMain: null };
    }

    return sendThroughBranch(this.host, row, text, there, async (body, head, levelledWith) => {

      const outgoing = inRepoEndings(body, head!.text);
      const saved = await this.host.backs.save(row.doc, outgoing, await deps.review.save(doc, outgoing, undefined, { toExistingReview: true, expectBranch: head!.sha }));
      if (saved.ok) {

        await memory.accepted(change.path, text, outgoing, levelledWith, saved.body);
        return { ok: true, expectMain: null };
      }
      const gone = deletedAtOf(saved);
      if (gone !== null) {
        deps.deleted?.(change.path, gone);
        return { ok: false, message: DELETED_WORDS.title, deleted: gone };
      }
      return behindOf(saved, COULDNT_FINISH) ?? { ok: false, message: failure(saved, COULDNT_FINISH) };
    }, { branch: status?.reviewBranch ?? undefined, level: async (mine) => levelWith(deps, row, mine, await deps.gitFile(doc)) });
  }

  async takeBranchText(row: ChangeRow): Promise<void> {
    const { deps, memory } = this.host;
    const branch = row.review?.reviewBranch;
    const there: BranchFile = branch ? await deps.branchFile(row.doc, branch) : { kind: "absent" };
    if (there.kind !== "file") return;
    const mine = await deps.readText(row.change.path);
    if (mine === null) return;
    if (toLf(mine) === toLf(there.text)) return void (await memory.remember(row.change.path, there.text, undefined, mine));
    const sent = await memory.sentBase(row, there, branch ?? undefined);
    const merged = await mergedWith(deps, row, mine, there.text, sent ?? deps.baseText(row.change.path));

    if (merged === null) return;
    await memory.writeAndRemember(row.change.path, mine, merged, there.text);
  }
}
