import type { RenamedTarget } from "../auth/git-copy";
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
  settled(path: string): void;
  leftAlone(looked: Looked, path: string, options?: { allowLive?: boolean; transientOnly?: boolean }): Promise<LeftAlone | null>;
  deferUnsaved(path: string): void;
  reads(): number;
  spendRead(): void;
  cutPass(): void;
  caseCollision(to: string, from: string): boolean;
  holdCaseCollision(path: string, key: string): void;
  holdRenamedKept(looked: Looked, path: string): void;
  forgetEnded(path: string): void;
  noteRenamed(from: string, to: string): void;
  noteRemoved(path: string): void;
  readonly awaiting: Map<string, { sent: string; to: string | null; agreed: string }>;
}

export class DraftRenames {
  private readonly since = new Map<string, number>();
  private readonly knownRenames = new Map<string, RenamedTarget>();

  constructor(
    private readonly ctx: DraftContext,
    private readonly host: RenameHost,
  ) {}

  dropSettled(looked: Looked, byPath: ReadonlyMap<string, Draft>): void {
    for (const path of [...this.since.keys()]) if (!byPath.has(path) || looked.files.has(path)) this.since.delete(path);
    for (const [path, moved] of [...this.knownRenames]) {
      if (!looked.files.has(path) || byPath.has(path)) {
        this.knownRenames.delete(path);
        continue;
      }
      const pending = [...byPath.keys()].some((to) => !looked.files.has(to) && this.ctx.ports.documentFor(to)?.path === moved.path);
      if (!pending) this.knownRenames.delete(path);
    }
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

  private async probeRenamedTo(
    from: string,
    fromDoc: DocumentRef,
    asked: Map<string, RenamedTarget | null | "unknown">,
  ): Promise<RenamedTarget | null | "wait"> {
    const known = this.knownRenames.get(from);
    if (known !== undefined) return known;
    if (asked.has(from)) {
      const seen = asked.get(from);
      return seen === "unknown" ? "wait" : (seen ?? null);
    }
    if (!this.ctx.ports.renamedTo) return null;
    if (!this.host.ready(from, false, true) || this.host.reads() >= READS_PER_PASS) {
      if (this.host.reads() >= READS_PER_PASS) this.host.cutPass();
      return "wait";
    }
    this.host.spendRead();
    const moved = await this.ctx.ports.renamedTo(fromDoc);
    if (!this.ctx.current()) return null;
    asked.set(from, moved);
    if (moved === "unknown") {
      this.host.wait(from);
      return "wait";
    }
    if (moved !== null) this.knownRenames.set(from, moved);
    return moved;
  }

  private async findByRenamedTo(
    looked: Looked,
    byPath: ReadonlyMap<string, Draft>,
    files: ReadonlyArray<[string, CacheEntry]>,
    toDoc: DocumentRef,
    draft: Draft,
    eligible: (pair: [string, CacheEntry]) => boolean,
    asked: Map<string, RenamedTarget | null | "unknown">,
  ): Promise<[string, CacheEntry] | null> {
    const { ports } = this.ctx;
    if (!ports.renamedTo) return null;
    for (const [from, entry] of files) {
      if (!eligible([from, entry]) || byPath.has(from)) continue;
      if (entry.sent === undefined && !isDraftOnly(looked, byPath, from, entry, ports.phaseOf(from))) continue;
      if (!follows(draft, ports.login(), entry.sentTo, ports.policy())) continue;
      const fromDoc = ports.documentFor(from);
      if (!fromDoc || fromDoc.repo !== toDoc.repo) continue;
      const moved = await this.probeRenamedTo(from, fromDoc, asked);
      if (!this.ctx.current()) return null;
      if (moved === "wait") continue;
      if (moved !== null && moved.path === toDoc.path) return [from, entry];
    }
    return null;
  }

  private isRenameCandidate(looked: Looked, byPath: ReadonlyMap<string, Draft>, to: string, draft: Draft, from: string, entry: CacheEntry): boolean {
    const { ports } = this.ctx;
    if (from === to || ports.inGroup(from) || ports.documentFor(from) === null || this.host.caseCollision(to, from)) return false;
    if (!follows(draft, ports.login(), entry.sentTo, ports.policy())) return false;
    const known = this.knownRenames.get(from);
    if (known !== undefined && ports.documentFor(to)?.path !== known.path) return false;
    if (isRenamedFrom(draft, from, to)) return true;
    if (entry.sent !== undefined && !byPath.has(from)) return true;
    if (isDraftOnly(looked, byPath, from, entry, ports.phaseOf(from))) return true;
    if (isRemovedBy(draft, from)) return draft.blob === null || bytesMatch(entry, draft.blob);
    return (draft.blob !== null && draft.blob !== EMPTY_BLOB && entry.sent === draft.blob) || isPublishedBytes(entry, draft.blob);
  }

  async pair(looked: Looked, byPath: ReadonlyMap<string, Draft>): Promise<{ changed: number; paths: Set<string>; heldFrom: Set<string> }> {
    const { ports, activity, state } = this.ctx;
    const out = { changed: 0, paths: new Set<string>(), heldFrom: new Set<string>() };
    let byBytes: Map<string, Array<[string, CacheEntry]>> | null = null;
    const askedRenames = new Map<string, RenamedTarget | null | "unknown">();
    for (const [to, draft] of byPath) {
      if (!this.ctx.current()) break;
      if (looked.files.has(to)) {
        byBytes ??= indexByBytes(looked.files);
        out.changed += await this.repairPair(looked, byPath, byBytes, to, draft, out.paths);
        continue;
      }
      if (looked.repo.has(to) || looked.deleted.some((gone) => gone.path === to) || ports.inGroup(to)) continue;
      const hold = (specificFrom?: string): void => {
        if (!this.mayBeRename(looked, byPath, to, draft) || !this.holding(to)) return;
        out.paths.add(to);
        if (specificFrom !== undefined) {
          if (!byPath.has(specificFrom)) out.heldFrom.add(specificFrom);
          return;
        }
        for (const [candidate, candidateEntry] of looked.files) {
          if (!byPath.has(candidate) && this.isRenameCandidate(looked, byPath, to, draft, candidate, candidateEntry)) {
            out.heldFrom.add(candidate);
          }
        }
      };
      if (draft.blob === null) {
        hold();
        continue;
      }
      const eligible = ([from]: [string, CacheEntry]): boolean => from !== to && !out.paths.has(from) && ports.documentFor(from) !== null && !ports.inGroup(from);
      const files = [...looked.files];
      let found =
        files.find((pair) => eligible(pair) && isRenamedFrom(draft, pair[0], to)) ??
        files.find(([from, entry]) => eligible([from, entry]) && (isRemovedBy(draft, from) || isDraftOnly(looked, byPath, from, entry, ports.phaseOf(from))) && bytesMatch(entry, draft.blob));
      if (!found) {
        const toDoc = ports.documentFor(to);
        if (toDoc) {
          const resolved = await this.findByRenamedTo(looked, byPath, files, toDoc, draft, eligible, askedRenames);
          if (!this.ctx.current()) break;
          if (resolved !== null) found = resolved;
        }
      }
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
        if (probed === "wait") hold(from);
        continue;
      }
      const { exactBlob, clean } = isCleanRenameSource(byPath, from, entry, draft);
      if (!clean) {
        const left = await this.host.leftAlone(looked, from, { transientOnly: true });
        if (!this.ctx.current()) break;
        if (left !== null && this.holding(to)) {
          if (left === "unsaved") this.host.deferUnsaved(from);
          out.paths.add(to);
          if (!byPath.has(from)) out.heldFrom.add(from);
          continue;
        }
        const token = looked.repo.get(from) ?? state.data.seen?.[from] ?? draft.branch;
        if (state.noteRenameTold(from, to, token, ports.now())) {
          ports.notify(DRAFT_SAID.renameKept(noteName(from), noteName(to)));
        }
        if (!byPath.has(from)) {
          if (entry.sent !== undefined) ports.agreed(from, null);
          this.host.forgetEnded(from);
          this.host.holdRenamedKept(looked, from);
          this.host.settled(from);
          out.paths.add(from);
        }
        continue;
      }
      const left = await this.host.leftAlone(looked, from, { allowLive: true });
      if (!this.ctx.current()) break;
      if (left !== null) {
        if (left === "unsaved") this.host.deferUnsaved(from);
        out.paths.add(to);
        if (!byPath.has(from)) out.heldFrom.add(from);
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
        if (!byPath.has(from)) out.heldFrom.add(from);
        continue;
      }
      this.host.noteRenamed(from, to);
      if (from !== to && !looked.repo.has(from)) ports.forgetDelete(from);
      state.data.committed.push(changeKey({ kind: "new", path: to }), changeKey({ kind: "renamed", path: to, from }));
      ports.agreed(from, null);
      this.host.forgetEnded(from);
      this.host.settled(from);
      const awaitingSent = exactBlob ? draft.blob : (entry.sent ?? entry.base ?? entry.sha);
      this.host.awaiting.set(to, { sent: awaitingSent, to: draftKey(draft), agreed: entry.sha });
      out.paths.add(from);
      out.paths.add(to);
      out.changed++;
    }
    return out;
  }

  mayBeRename(looked: Looked, byPath: ReadonlyMap<string, Draft>, to: string, draft: Draft): boolean {
    return [...looked.files].some(([from, entry]) => this.isRenameCandidate(looked, byPath, to, draft, from, entry));
  }

  moving(looked: Looked, path: string, entry: Pick<CacheEntry, "sha" | "sent" | "sentTo" | "base">): boolean {
    const { ports } = this.ctx;
    const now = ports.now();
    const byPath = looked.drafts?.byPath;
    if (!byPath) return false;
    const fromDoc = ports.documentFor(path);
    const knownTarget = this.knownRenames.get(path)?.path;
    for (const [to, draft] of byPath) {
      if (to === path || looked.files.has(to)) continue;
      if (!follows(draft, ports.login(), entry.sentTo, ports.policy())) continue;
      if (isRenamedFrom(draft, path, to)) return true;
      const toDoc = ports.documentFor(to);
      if (fromDoc && toDoc && knownTarget !== undefined && knownTarget === toDoc.path) return true;
      if ((isRemovedBy(draft, path) || isDraftOnly(looked, byPath, path, entry, ports.phaseOf(path))) && bytesMatch(entry, draft.blob)) return true;
      if ((draft.blob === null || (!looked.repo.has(to) && isDraftOnly(looked, byPath, path, entry, ports.phaseOf(path)))) && (this.since.get(to) ?? now) + RENAME_HOLD_MS >= now) return true;
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
      this.host.forgetEnded(from);
      this.host.settled(from);
      paths.add(from);
      return 1;
    }
    return 0;
  }
}
