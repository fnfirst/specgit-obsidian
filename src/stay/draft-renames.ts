import { agreedOf, type CacheEntry } from "../changes/cache";
import type { Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { type DocumentRef, noteName } from "../mapping";
import type { NotePhase } from "../status";
import type { DraftContext } from "./draft-inbound";
import { type Draft, draftKey, follows, isClean, type LeftAlone } from "./draft-state";
import { EMPTY_BLOB, READS_PER_PASS } from "./inbound";
import { changeKey } from "./outbound";
import { DRAFT_SAID } from "./words";

export const RENAME_HOLD_MS = 120_000;

const isPublishedBytes = (entry: Pick<CacheEntry, "base">, blob: string | null): boolean => blob !== null && blob !== EMPTY_BLOB && entry.base === blob;

const isRenamedFrom = (draft: Draft, from: string, to: string): boolean => draft.removes?.get(from) === to;
const isRemovedBy = (draft: Draft, from: string): boolean => draft.removes?.get(from) === null;

const isDraftOnly = (looked: Looked, byPath: ReadonlyMap<string, Draft>, from: string, entry: Pick<CacheEntry, "sent">, phase: NotePhase): boolean =>
  !looked.repo.has(from) && !byPath.has(from) && (entry.sent !== undefined || phase === "live");

const bytesMatch = (entry: Pick<CacheEntry, "sha" | "sent" | "base">, blob: string | null): boolean =>
  blob !== null && blob !== EMPTY_BLOB && (entry.sha === blob || entry.sent === blob || isPublishedBytes(entry, blob));

const isCleanRenameSource = (byPath: ReadonlyMap<string, Draft>, from: string, entry: CacheEntry, draft: Draft): { exactBlob: boolean; clean: boolean } => {
  const exactBlob = draft.blob !== null && draft.blob !== EMPTY_BLOB && entry.sha === draft.blob;
  if (exactBlob) return { exactBlob: true, clean: true };
  const agreed = agreedOf(entry);
  const sameDraft = entry.sent !== undefined && !byPath.has(from) && (entry.sentTo === undefined || entry.sentTo === draftKey(draft));
  const clean = sameDraft
    ? isClean({ sha: entry.sha, ...(agreed !== undefined ? { agreed } : {}), unchanged: unchangedHere(entry) })
    : unchangedHere(entry);
  return { exactBlob: false, clean };
};

const indexByBytes = (files: Looked["files"]): Map<string, Array<[string, CacheEntry]>> => {
  const byBytes = new Map<string, Array<[string, CacheEntry]>>();
  const add = (key: string, pair: [string, CacheEntry]): void => {
    const list = byBytes.get(key);
    if (list) list.push(pair);
    else byBytes.set(key, [pair]);
  };
  for (const [path, entry] of files) {
    if (entry.sha !== EMPTY_BLOB) add(entry.sha, [path, entry]);
    if (unchangedHere(entry) && isPublishedBytes(entry, entry.base) && entry.base !== entry.sha) add(entry.base!, [path, entry]);
  }
  return byBytes;
};

export interface RenameHost {
  ready(path: string, spend: boolean, pairing: boolean): boolean;
  wait(path: string): void;
  leftAlone(looked: Looked, path: string, options?: { allowLive?: boolean }): Promise<LeftAlone | null>;
  reads(): number;
  spendRead(): void;
  cutPass(): void;
  caseCollision(to: string, from: string): boolean;
  holdCaseCollision(path: string, key: string): void;
  noteRenamed(from: string, to: string): void;
  noteRemoved(path: string): void;
  readonly awaiting: Map<string, { sent: string; to: string | null; agreed: string }>;
}

export class DraftRenames {
  private readonly since = new Map<string, number>();
  private readonly told = new Set<string>();

  constructor(
    private readonly ctx: DraftContext,
    private readonly host: RenameHost,
  ) {}

  dropSettled(looked: Looked, byPath: ReadonlyMap<string, Draft>): void {
    for (const path of [...this.since.keys()]) if (!byPath.has(path) || looked.files.has(path)) this.since.delete(path);
  }

  private async probeAbsent(from: string, fromDoc: DocumentRef, branch: string): Promise<"absent" | "present" | "wait"> {
    if (!this.host.ready(from, false, true) || this.host.reads() >= READS_PER_PASS) {
      if (this.host.reads() >= READS_PER_PASS) this.host.cutPass();
      return "wait";
    }
    this.host.spendRead();
    const old = await this.ctx.ports.draftFile(fromDoc, branch);
    if (!this.ctx.current()) return "present";
    if (old.kind === "absent") return "absent";
    return old.kind === "file" ? "present" : "wait";
  }

  async pair(looked: Looked, byPath: ReadonlyMap<string, Draft>): Promise<{ changed: number; paths: Set<string> }> {
    const { ports, activity, state } = this.ctx;
    const out = { changed: 0, paths: new Set<string>() };
    let byBytes: Map<string, Array<[string, CacheEntry]>> | null = null;
    for (const [to, draft] of byPath) {
      if (!this.ctx.current()) break;
      if (looked.files.has(to)) {
        byBytes ??= indexByBytes(looked.files);
        out.changed += await this.repairPair(looked, byPath, byBytes, to, draft, out.paths);
        continue;
      }
      if (looked.repo.has(to) || looked.deleted.some((gone) => gone.path === to) || ports.inGroup(to)) continue;
      const possible = this.mayBeRename(looked, byPath, to, draft);
      const hold = (): void => {
        if (possible && this.holding(to)) out.paths.add(to);
      };
      if (draft.blob === null) {
        hold();
        continue;
      }
      const eligible = ([from]: [string, CacheEntry]): boolean => from !== to && !out.paths.has(from) && ports.documentFor(from) !== null && !ports.inGroup(from);
      const files = [...looked.files];
      const found =
        files.find((pair) => eligible(pair) && isRenamedFrom(draft, pair[0], to)) ??
        files.find(([from, entry]) => eligible([from, entry]) && (isRemovedBy(draft, from) || isDraftOnly(looked, byPath, from, entry, ports.phaseOf(from))) && bytesMatch(entry, draft.blob));
      if (!found) {
        hold();
        continue;
      }
      const [from, entry] = found;
      const [fromDoc, toDoc] = [ports.documentFor(from), ports.documentFor(to)];
      if (!fromDoc || !toDoc || !follows(draft, ports.login(), entry.sentTo, ports.policy())) continue;
      if (this.host.caseCollision(to, from)) {
        this.host.holdCaseCollision(to, draft.blob ?? draft.branch);
        out.paths.add(from);
        out.paths.add(to);
        continue;
      }
      const probed = await this.probeAbsent(from, fromDoc, draft.branch);
      if (!this.ctx.current()) break;
      if (probed !== "absent") {
        if (probed === "wait") hold();
        continue;
      }
      const { exactBlob, clean } = isCleanRenameSource(byPath, from, entry, draft);
      if ((await this.host.leftAlone(looked, from, { allowLive: exactBlob })) !== null) {
        out.paths.add(to);
        continue;
      }
      if (!clean) {
        const key = `${from}|${to}|${draft.blob}`;
        if (!this.told.has(key)) {
          this.told.add(key);
          ports.notify(DRAFT_SAID.renameKept(noteName(from), noteName(to)));
        }
        continue;
      }
      activity.ownWrite(from, to);
      const moved = await ports.vault.rename(from, to);
      if (moved !== "renamed") {
        activity.notWritten(from, to);
        if (moved === "exists" && !ports.vault.exists(to)) {
          this.host.holdCaseCollision(to, draft.blob ?? draft.branch);
          out.paths.add(from);
          out.paths.add(to);
          continue;
        }
        this.host.wait(from);
        out.paths.add(to);
        continue;
      }
      this.host.noteRenamed(from, to);
      if (from !== to && !looked.repo.has(from)) ports.forgetDelete(from);
      state.data.committed.push(changeKey({ kind: "new", path: to }), changeKey({ kind: "renamed", path: to, from }));
      ports.agreed(from, null);
      const awaitingSent = exactBlob ? draft.blob : (entry.sent ?? entry.base ?? entry.sha);
      this.host.awaiting.set(to, { sent: awaitingSent, to: draftKey(draft), agreed: entry.sha });
      out.paths.add(from);
      out.paths.add(to);
      out.changed++;
    }
    return out;
  }

  mayBeRename(looked: Looked, byPath: ReadonlyMap<string, Draft>, to: string, draft: Draft): boolean {
    const { ports } = this.ctx;
    return [...looked.files].some(([from, entry]) => {
      if (from === to || ports.inGroup(from) || ports.documentFor(from) === null || this.host.caseCollision(to, from)) return false;
      if (isRenamedFrom(draft, from, to)) return true;
      if (entry.sent !== undefined && !byPath.has(from)) return true;
      if (isDraftOnly(looked, byPath, from, entry, ports.phaseOf(from))) return true;
      if (isRemovedBy(draft, from)) return draft.blob === null || bytesMatch(entry, draft.blob);
      return (draft.blob !== null && draft.blob !== EMPTY_BLOB && entry.sent === draft.blob) || isPublishedBytes(entry, draft.blob);
    });
  }

  moving(looked: Looked, path: string, sha: string): boolean {
    for (const [to, draft] of looked.drafts?.byPath ?? []) {
      if (to === path || looked.files.has(to)) continue;
      if (draft.blob === sha) return true;
      if (draft.blob === null && (this.since.get(to) ?? this.ctx.ports.now()) + RENAME_HOLD_MS >= this.ctx.ports.now()) return true;
    }
    return false;
  }

  holding(to: string): boolean {
    const now = this.ctx.ports.now();
    const since = this.since.get(to) ?? now;
    this.since.set(to, since);
    return now - since <= RENAME_HOLD_MS;
  }

  private async repairPair(looked: Looked, byPath: ReadonlyMap<string, Draft>, byBytes: ReadonlyMap<string, Array<[string, CacheEntry]>>, to: string, draft: Draft, paths: Set<string>): Promise<number> {
    const { ports, activity } = this.ctx;
    const at = looked.files.get(to);
    if (!at || ports.inGroup(to) || looked.repo.has(to)) return 0;
    for (const [from, entry] of byBytes.get(at.sha) ?? []) {
      const removed = isRenamedFrom(draft, from, to) || isRemovedBy(draft, from);
      if (from === to || (byPath.has(from) && !removed) || paths.has(from) || ports.inGroup(from)) continue;
      if (!removed && !isDraftOnly(looked, byPath, from, entry, ports.phaseOf(from))) continue;
      if (entry.sent === undefined && at.sha !== draft.blob) continue;
      const fromDoc = ports.documentFor(from);
      const { clean } = isCleanRenameSource(byPath, from, entry, draft);
      if (!fromDoc || !follows(draft, ports.login(), entry.sentTo, ports.policy()) || !clean) continue;
      const probed = await this.probeAbsent(from, fromDoc, draft.branch);
      if (!this.ctx.current()) return 0;
      if (probed !== "absent" || (await this.host.leftAlone(looked, from)) !== null) continue;
      activity.ownWrite(from);
      if (!(await ports.vault.trash(from, entry.sha))) {
        activity.notWritten(from);
        this.host.wait(from);
        continue;
      }
      this.host.noteRemoved(from);
      if (!looked.repo.has(from)) ports.forgetDelete(from);
      ports.agreed(from, null);
      paths.add(from);
      return 1;
    }
    return 0;
  }
}
