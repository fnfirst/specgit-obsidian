import { withBytes } from "./attachment-memory";
import { noteName } from "../mapping";
import { REVIEW_UNCHECKED, REVIEW_UNCHECKED_TITLE } from "./flow-helpers";
import { toLf } from "../disk/line-endings";
import { isTextOfBytes } from "./blob-sha";
import { BURST_FROM, leftOutWords, newUploadId, planBurst, planBurstParts, sendBurst } from "./burst";
import { attachmentAnswer, nameAttachments, type NamedAttachment } from "./attachment-send";
import { isLostAnswerResult } from "../review/review-api";
import { isLimited } from "./flow-helpers";
import type { Sent } from "./flow-helpers";
import { type ChangeRow, type ChangesModel, type Doing } from "./model";
import type { Dialogs, FlowDeps } from "./flow-deps";
import type { SyncedAll } from "./member-sync";
import type { ReadBacks } from "./read-back";
import type { SentMemory } from "./sent-memory";
import {
  DELETE_CANT_JOIN,
  endingConfirm,
  GROUP_BUSY_WORDS,
  GROUP_FAILED_TITLE,
  groupFailedWords,
  groupPlan,
  type BurstFile,
  type GroupLeftOut,
  type GroupPlan,
  newGroupName,
  NOTHING_TO_GROUP,
  nothingToGroupWords,
  sameAsGitHubWords,
  type UngroupAnswer,
  unitKey,
  ungroupTitle,
  ungroupUnsentConfirm,
} from "../shared/review-flow";

const fileNameOf = (path: string): string => path.split("/").pop() ?? path;

export type GroupChange = { ok: true; id?: string; ungrouped?: UngroupAnswer; writes?: number } | { ok: false; limited?: true; writes?: number };

export interface GroupHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
  readonly backs: ReadBacks;

  readonly meter: { writes: number };
  busy<T>(work: () => Promise<T>, doing: Doing): Promise<T>;
  alert(options: Parameters<Dialogs["alert"]>[0]): Promise<void>;
  syncAll(rows: readonly ChangeRow[], group: string): Promise<Sent | SyncedAll>;

  readonly memory: SentMemory;

  takeBranchText(row: ChangeRow): Promise<void>;
}

export const groupableRows = (rows: readonly ChangeRow[]): ChangeRow[] => rows.filter((row) => row.change.kind !== "renamed" && row.change.kind !== "deleted");

export class GroupFlows {
  constructor(private readonly host: GroupHost) {}

  groupPlan(selected: readonly ChangeRow[]): GroupPlan {
    const deleted = new Set(selected.filter((row) => row.change.kind === "deleted" && !row.group).map((row) => row.unit.path));
    return groupPlan(selected.map((row) => row.unit), { entitled: !this.host.model.state().groupsLocked, cannotJoin: (entry) => (deleted.has(entry.path) ? DELETE_CANT_JOIN : null), noun: "note" });
  }

  private async groupFailed(message: string, code?: string | null, body?: Record<string, unknown> | null): Promise<GroupChange> {

    const written = typeof body?.written === "number" ? body.written : undefined;
    const retry = typeof body?.retry === "boolean" ? body.retry : undefined;
    await this.host.alert({ title: GROUP_FAILED_TITLE, description: groupFailedWords(message || "Something went wrong.", code, { ...(written === undefined ? {} : { written }), ...(retry === undefined ? {} : { retry }) }) });
    return { ok: false };
  }

  private refused(answer: { message: string; code: string | null; body?: Record<string, unknown> | null }): Promise<GroupChange> {
    return this.groupFailed(answer.message, answer.code, answer.body);
  }

  private leftOutWords(rows: readonly ChangeRow[], same: ReadonlySet<string>, answer: Record<string, unknown>): string | null {
    const server = new Set((Array.isArray(answer.left) ? (answer.left as GroupLeftOut[]) : []).map((one) => one.path));
    return sameAsGitHubWords(rows.filter((row) => same.has(row.change.path) || server.has(row.doc.path)).map((row) => fileNameOf(row.change.path)));
  }

  private async sendAll(rows: readonly ChangeRow[], group: string): Promise<ReadonlySet<string> | false | "limited"> {
    const sent = await this.host.syncAll(rows, group);
    if ("held" in sent) return false;
    if (!sent.ok) {
      await this.groupFailed(sent.message);
      return "limited" in sent && sent.limited === true ? "limited" : false;
    }
    return new Set("same" in sent ? sent.same : []);
  }

  private async remaining(rows: readonly ChangeRow[], same: ReadonlySet<string>, needs: 1 | 2): Promise<ChangeRow[] | null> {
    const keep = rows.filter((row) => !same.has(row.change.path));
    if (keep.length >= needs) return keep;
    await this.groupFailed(nothingToGroupWords(rows.filter((row) => same.has(row.change.path)).map((row) => fileNameOf(row.change.path)), needs), NOTHING_TO_GROUP);
    return null;
  }

  async createGroup(asked: readonly ChangeRow[]): Promise<GroupChange> {
    return this.host.busy(async () => {
      const before = this.host.meter.writes;
      const made = await this.makeGroup(asked);
      const writes = this.host.meter.writes - before;
      return writes > 0 ? { ...made, writes } : made;
    }, { words: GROUP_BUSY_WORDS.create, paths: asked.map((row) => row.change.path) });
  }

  private async unchecked(read: readonly ChangeRow[]): Promise<boolean> {
    const rows = read.filter((row) => row.unchecked === true);
    if (rows.length === 0) return false;
    await this.host.alert({ title: REVIEW_UNCHECKED_TITLE, description: REVIEW_UNCHECKED(rows.map((row) => noteName(row.change.path))) });
    return true;
  }

  private async makeGroup(asked: readonly ChangeRow[]): Promise<GroupChange> {

    if (!this.host.model.state().groupsLocked) {
      const rows = asked.map((row) => this.host.model.row(row.change.path) ?? row);
      if (asked.length > BURST_FROM) return this.burstGroup(rows);

      const { send } = planBurst(rows);
      if (send.length >= 2) {
        const together = new Set(send.map((pick) => pick.row.change.path));
        return this.burstGroup(send.map((pick) => pick.row), rows.filter((row) => !together.has(row.change.path)));
      }
    }
    return this.usualGroup(asked);
  }

  private async usualGroup(asked: readonly ChangeRow[]): Promise<GroupChange> {
    const read = await this.host.model.read(asked);
    if (await this.unchecked(read)) return { ok: false };
    const same = await this.sendAll(read, "the new group");
    if (same === "limited") return { ok: false, limited: true };
    if (same === false) return { ok: false };
    const files = await this.remaining(read, same, 2);
    if (files === null) return { ok: false };
    const repo = files[0]!.doc.repo;
    const paths = files.map((row) => row.doc.path);
    const made = await this.host.deps.review.group(repo, "create", { paths, name: newGroupName(this.host.model.state().units) });
    if (made.ok) {
      const words = this.leftOutWords(read, same, made.body);
      if (words) this.host.deps.dialogs.toast("Some files weren't grouped", words);
      return { ok: true, id: typeof made.body.id === "string" ? made.body.id : undefined };
    }
    const landed = await this.host.backs.group(made, repo, paths);
    if (landed !== null) return { ok: true, id: landed };
    return { ...(await this.refused(made)), ...(isLimited(made) ? { limited: true as const } : {}) };
  }

  private readonly uploads = new Map<string, string>();

  private async burstGroup(files: readonly ChangeRow[], usual: readonly ChangeRow[] = [], attachments: "ask" | "none" = "ask"): Promise<GroupChange> {
    const { send, left } = planBurst(files);
    const words = leftOutWords(left);
    if (send.length < 2) {
      await this.groupFailed(`A group needs at least two files, and fewer than two of these can be grouped. ${words ?? ""}`.trim());
      return { ok: false };
    }
    const texts = await Promise.all(send.map((pick) => this.host.deps.readText(pick.row.change.path)));
    const burst = send.flatMap((pick, i) => (texts[i] === null ? [] : [{ path: pick.row.doc.path, content: toLf(texts[i]!), base: pick.base }]));
    if (burst.length < 2) {
      await this.groupFailed("specgit couldn't read those files in your vault just now. Try again in a moment.");
      return { ok: false };
    }
    const repo = send[0]!.row.doc.repo;
    const key = burst.map((file) => file.path).sort().join("\n");
    const uploadId = this.uploads.get(key) ?? newUploadId();
    this.uploads.set(key, uploadId);
    const name = newGroupName(this.host.model.state().units);

    const attachmentsOf = new Map<string, NamedAttachment[]>();
    for (const [i, pick] of send.entries()) {
      if (attachments === "none") break;
      if (texts[i] === null || !/\.md$/i.test(pick.row.change.path)) continue;
      const have = await withBytes(await this.host.deps.attachments(pick.row.change.path));
      this.host.deps.attachmentTold?.(pick.row.change.path, have.told);
      const found = await nameAttachments(have.attachments);
      if (found.length > 0) attachmentsOf.set(pick.row.doc.path, found);
    }
    const pause = (ms: number): Promise<void> => this.host.deps.pause?.(ms) ?? new Promise((resume) => window.setTimeout(resume, ms));
    const upload = (part: { uploadId: string; last: boolean; files: readonly BurstFile[]; attachments?: readonly NamedAttachment[]; named?: readonly NamedAttachment[] }) =>
      this.host.deps.review.group(repo, "burst", { name, upload: { uploadId: part.uploadId, last: part.last, files: part.files, ...(part.attachments || part.named ? { attachments: [...(part.attachments ?? []).map((attachment) => ({ filePath: attachment.repoPath, sha: attachment.sha, size: attachment.size, base64: attachment.base64 })), ...(part.named ?? []).map((attachment) => ({ filePath: attachment.repoPath, sha: attachment.sha, size: attachment.size }))] } : {}) } });

    let needed: ReadonlySet<string> | null = null;
    if (attachmentsOf.size > 0) {
      const unique = [...new Map([...attachmentsOf.values()].flat().map((attachment) => [`${attachment.repoPath}\n${attachment.sha}`, attachment])).values()];
      let said: Record<string, unknown> | null = null;
      const asked = await sendBurst(upload, [{ files: [], named: unique }], uploadId, pause, { last: false, onAnswer: (body) => void (said = body) });
      const echo = said === null ? null : attachmentAnswer(said);
      if (!asked.ok && isLostAnswerResult(asked.result)) return { ...(await this.groupFailed(asked.result.message, asked.result.code, asked.result.body)) };
      if (!asked.ok || echo === null) {
        if (!asked.ok && asked.result.status !== 400) return { ...(await this.groupFailed(asked.result.message, asked.result.code, asked.result.body)), ...(isLimited(asked.result) ? { limited: true as const } : {}) };
        const withAttachments = send.filter((pick) => attachmentsOf.has(pick.row.doc.path)).map((pick) => pick.row);
        const without = send.filter((pick) => !attachmentsOf.has(pick.row.doc.path)).map((pick) => pick.row);
        this.uploads.delete(key);
        if (without.length >= 2) return this.burstGroup(without, [...usual, ...withAttachments], "none");
        return this.usualGroup([...files, ...usual]);
      }
      needed = echo.needed;
    }

    const wanted = new Map<string, NamedAttachment[]>();
    for (const [path, found] of attachmentsOf) {
      const lacking = found.filter((attachment) => needed === null || needed.has(attachment.repoPath));
      if (lacking.length > 0) wanted.set(path, lacking);
    }
    const parts = planBurstParts(burst, wanted);
    const done = await sendBurst(upload, parts, uploadId, pause);
    if (!done.ok) return { ...(await this.groupFailed(done.result.message, done.result.code, done.result.body)), ...(isLimited(done.result) ? { limited: true as const } : {}) };
    this.uploads.delete(key);

    const leftOnServer = new Set(done.left.map((one) => one.path));
    await this.host.memory.rememberMany(send.flatMap((pick, i) => (texts[i] !== null && !leftOnServer.has(pick.row.doc.path) ? [[pick.row.change.path, toLf(texts[i]!)] as const] : [])));

    const level = send.flatMap((pick, i) => {
      const said = done.left.find((one) => one.why === "same" && one.path === pick.row.doc.path);
      return said ? [{ pick, text: texts[i] ?? null, comparedWith: said.sha }] : [];
    });

    for (const { pick, text, comparedWith } of level) if (text !== null && comparedWith !== undefined && comparedWith === pick.row.change.repoSha && isTextOfBytes(text, pick.row.change.sha)) this.host.model.learnSame(pick.row.change.path, pick.row.change.sha, comparedWith, "server");
    const leftOut = [sameAsGitHubWords(level.map(({ pick }) => fileNameOf(pick.row.change.path))), leftOutWords([...left, ...done.left.filter((one) => one.why !== "same")])].filter((words) => words !== null).join(" ");
    if (leftOut) this.host.deps.dialogs.toast(`Grouped ${burst.length - done.left.length} files`, leftOut);

    if (usual.length > 0 && done.id) {
      const added = await this.addRows(repo, done.id, name, usual, true);
      if (!added.ok) return added;
    }
    return { ok: true, ...(done.id ? { id: done.id } : {}) };
  }

  async addToGroup(group: ChangeRow, asked: readonly ChangeRow[]): Promise<GroupChange> {
    return this.host.busy(async () => this.addRows(group.doc.repo, group.group!.id, group.unit.name, asked), { words: GROUP_BUSY_WORDS.add, paths: asked.map((row) => row.change.path) });
  }

  private async addRows(repo: string, id: string, name: string, asked: readonly ChangeRow[], quiet = false): Promise<GroupChange> {
    const read = await this.host.model.read(asked);
    if (await this.unchecked(read)) return { ok: false };
    const same = await this.sendAll(read, name);
    if (same === false || same === "limited") return { ok: false };
    if (quiet && read.every((row) => same.has(row.change.path))) return { ok: true };
    const files = await this.remaining(read, same, 1);
    if (files === null) return { ok: false };
    const paths = files.map((row) => row.doc.path);
    const added = await this.host.deps.review.group(repo, "add", { id, paths });
    if (added.ok) {
      const words = this.leftOutWords(read, same, added.body);
      if (words) this.host.deps.dialogs.toast("Some files weren't grouped", words);
      return { ok: true };
    }
    if ((await this.host.backs.group(added, repo, paths, id)) !== null) return { ok: true };
    return this.refused(added);
  }

  async takeOut(group: ChangeRow, path: string): Promise<GroupChange> {
    const doc = this.host.deps.documentFor(path);
    if (!doc) return { ok: false };

    const wasChecked = this.host.model.isSelected(unitKey(group.unit));
    return this.host.busy(async () => {
      const out = await this.host.deps.review.group(group.doc.repo, "remove", { id: group.group!.id, paths: [doc.path] });
      if (!out.ok) return this.groupFailed(out.message, out.code, out.body);
      this.host.model.leftGroup([path], wasChecked);
      return { ok: true };
    }, { words: GROUP_BUSY_WORDS.remove, paths: [path] });
  }

  private async vaultSent(group: ChangeRow): Promise<{ path: string; sha: string }[]> {
    const said = await Promise.all(
      group.group!.files.map(async (file) => {
        const doc = this.host.deps.documentFor(file.path);
        const sha = this.host.model.sentSha(file.path);
        return doc && sha !== null && (await this.host.deps.readText(file.path)) !== null ? { path: doc.path, sha } : null;
      }),
    );
    return said.flatMap((one) => (one ? [one] : []));
  }

  async ungroup(group: ChangeRow): Promise<GroupChange> {
    const { id, overview, files } = group.group!;
    const repo = group.doc.repo;

    const unsent = await this.vaultSent(group);
    const dry = unsent.length > 0 ? await this.host.deps.review.group(repo, "ungroup", { id, unsent, dryRun: true }) : null;
    const preview = dry?.ok && typeof dry.body.unsent === "number" && typeof dry.body.own === "number" ? { unsent: dry.body.unsent, own: dry.body.own } : null;
    if (preview !== null && preview.unsent > 0) {
      if (!(await this.host.deps.dialogs.confirm({ title: ungroupTitle(overview.name), description: ungroupUnsentConfirm(preview), confirmLabel: "Ungroup" }))) return { ok: false };
    } else {

      const long = endingConfirm(files.length);
      if (long !== null && !(await this.host.deps.dialogs.confirm({ title: `Take apart ${overview.name}?`, description: long, confirmLabel: "Take apart" }))) return { ok: false };
    }
    const wasChecked = this.host.model.isSelected(unitKey(group.unit));
    return this.host.busy(async () => {
      const ended = await this.host.deps.review.group(repo, "ungroup", { id, ...(preview !== null && preview.unsent > 0 ? { unsent } : {}) });
      if (!ended.ok) return this.groupFailed(ended.message, ended.code, ended.body);

      this.host.model.leftGroup(files.map((file) => file.path), wasChecked);
      this.forgetReviewsOfUnsent(files, ended.body);

      return { ok: true, ungrouped: ended.body };
    }, { words: GROUP_BUSY_WORDS.ungroup, paths: files.map((file) => file.path) });
  }

  private forgetReviewsOfUnsent(files: readonly { path: string }[], answer: UngroupAnswer): void {
    const back = new Set(answer.unsent ?? []);
    if (back.size === 0) return;
    for (const file of files) {
      const doc = this.host.deps.documentFor(file.path);
      if (doc && back.has(doc.path)) this.host.model.learn(file.path, { reviewBranch: null, pr: null });
    }
  }

  async stopEnding(group: ChangeRow): Promise<GroupChange> {
    const stopped = await this.host.deps.review.group(group.doc.repo, "stop", { id: group.group!.id });
    void this.host.model.refresh();
    return stopped.ok ? { ok: true } : this.groupFailed(stopped.message, stopped.code, stopped.body);
  }

  async renameGroup(group: ChangeRow, name: string): Promise<GroupChange> {
    return this.host.busy(async () => {
      const renamed = await this.host.deps.review.group(group.doc.repo, "rename", { id: group.group!.id, name });
      return renamed.ok ? { ok: true } : this.groupFailed(renamed.message, renamed.code, renamed.body);
    }, { words: GROUP_BUSY_WORDS.rename, paths: [] });
  }

  async resolveGroup(group: ChangeRow, pick: "mine" | "theirs"): Promise<GroupChange> {
    const { id, overview, members, files } = group.group!;
    return this.host.busy(async () => {
      const settled = await this.host.deps.review.group(group.doc.repo, "resolve", { id, resolve: pick });
      if (!settled.ok) return this.refused(settled);
      if (pick === "theirs") for (const row of members.filter((member) => overview.holdPaths.includes(member.change.path))) await this.host.takeBranchText(row);
      return { ok: true };
    }, { words: GROUP_BUSY_WORDS.resolve, paths: files.map((file) => file.path) });
  }
}
