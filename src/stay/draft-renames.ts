import { agreedOf, type CacheEntry } from "../changes/cache";
import type { Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { noteName } from "../mapping";
import type { DraftContext } from "./draft-inbound";
import { type Draft, draftKey, follows, isClean, type LeftAlone } from "./draft-state";
import { READS_PER_PASS } from "./inbound";
import { changeKey } from "./outbound";
import { DRAFT_SAID } from "./words";

export const RENAME_HOLD_MS = 120_000;

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const isPublishedBytes = (entry: Pick<CacheEntry, "base">, blob: string | null): boolean => blob !== null && blob !== EMPTY_BLOB && entry.base === blob;

export interface RenameHost {

  ready(path: string, spend: boolean, pairing: boolean): boolean;

  wait(path: string): void;

  leftAlone(looked: Looked, path: string): Promise<LeftAlone | null>;

  reads(): number;

  spendRead(): void;

  cutPass(): void;

  readonly awaiting: Map<string, { sent: string; to: string | null; agreed: string }>;
}

const removesPath = (draft: Draft, from: string, to: string): boolean => {
  const moved = draft.removes?.get(from);
  return moved === null || moved === to;
};

const onlyInDrafts = (looked: Looked, byPath: ReadonlyMap<string, Draft>, from: string, entry: Pick<CacheEntry, "sent">): boolean => entry.sent !== undefined && !looked.repo.has(from) && !byPath.has(from);

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

  async pair(looked: Looked, byPath: ReadonlyMap<string, Draft>): Promise<{ changed: number; paths: Set<string> }> {
    const { ports, activity, state } = this.ctx;
    const out = { changed: 0, paths: new Set<string>() };

    let byBytes: Map<string, Array<[string, CacheEntry]>> | null = null;
    for (const [to, draft] of byPath) {
      if (!this.ctx.current()) break;
      if (looked.files.has(to)) {
        if (byBytes === null) {
          byBytes = new Map();

          for (const [path, entry] of looked.files) {
            const key = entry.sent !== undefined ? entry.sha : isPublishedBytes(entry, entry.base) ? entry.base : null;
            if (key !== null) byBytes.set(key, [...(byBytes.get(key) ?? []), [path, entry]]);
          }
        }
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

      const found = [...looked.files].find(([from, entry]) => (entry.sent === draft.blob || isPublishedBytes(entry, draft.blob)) && from !== to && !out.paths.has(from) && ports.documentFor(from) !== null && !ports.inGroup(from));
      if (!found) {
        hold();
        continue;
      }
      const [from, entry] = found;

      if (!removesPath(draft, from, to) && !onlyInDrafts(looked, byPath, from, entry)) {
        hold();
        continue;
      }
      const [fromDoc, toDoc] = [ports.documentFor(from), ports.documentFor(to)];
      if (!fromDoc || !toDoc || !follows(draft, ports.login(), entry.sentTo, ports.policy())) continue;
      if (!this.host.ready(from, false, true) || this.host.reads() >= READS_PER_PASS) {
        if (this.host.reads() >= READS_PER_PASS) this.host.cutPass();
        hold();
        continue;
      }

      this.host.spendRead();
      const old = await ports.draftFile(fromDoc, draft.branch);
      if (!this.ctx.current()) break;
      if (old.kind !== "absent") {

        if (old.kind !== "file") hold();
        continue;
      }

      if ((await this.host.leftAlone(looked, from)) !== null) {
        out.paths.add(to);
        continue;
      }

      const agreed = agreedOf(entry);
      const clean = entry.sent === draft.blob ? isClean({ sha: entry.sha, ...(agreed !== undefined ? { agreed } : {}), unchanged: unchangedHere(entry) }) : unchangedHere(entry);
      if (!clean) {
        const key = `${from}|${to}|${draft.blob}`;
        if (!this.told.has(key)) {
          this.told.add(key);
          ports.notify(DRAFT_SAID.renameKept(noteName(from), noteName(to)));
        }
        continue;
      }
      activity.ownWrite(from, to);
      if ((await ports.vault.rename(from, to)) !== "renamed") {
        activity.notWritten(from, to);
        this.host.wait(from);
        out.paths.add(to);
        continue;
      }

      state.data.committed.push(changeKey({ kind: "new", path: to }), changeKey({ kind: "renamed", path: to, from }));
      ports.agreed(from, null);
      this.host.awaiting.set(to, { sent: draft.blob, to: draftKey(draft), agreed: entry.sha });
      out.paths.add(from);
      out.paths.add(to);
      out.changed++;
    }
    return out;
  }

  mayBeRename(looked: Looked, byPath: ReadonlyMap<string, Draft>, to: string, draft: Draft): boolean {
    const { ports } = this.ctx;
    return [...looked.files].some(([from, entry]) => {
      if (from === to || ports.inGroup(from) || ports.documentFor(from) === null) return false;

      if (entry.sent !== undefined && !byPath.has(from)) return true;
      return (draft.blob !== null && entry.sent === draft.blob) || isPublishedBytes(entry, draft.blob);
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

      if (from === to || (byPath.has(from) && !removesPath(draft, from, to)) || paths.has(from) || ports.inGroup(from)) continue;
      if (!removesPath(draft, from, to) && !onlyInDrafts(looked, byPath, from, entry)) continue;

      if (entry.sent === undefined && at.sha !== draft.blob) continue;
      const fromDoc = ports.documentFor(from);
      const agreed = agreedOf(entry);
      const clean = entry.sent !== undefined ? isClean({ sha: entry.sha, ...(agreed !== undefined ? { agreed } : {}), unchanged: unchangedHere(entry) }) : unchangedHere(entry);
      if (!fromDoc || !follows(draft, ports.login(), entry.sentTo, ports.policy()) || !clean) continue;
      if (!this.host.ready(from, false, true) || this.host.reads() >= READS_PER_PASS) {
        if (this.host.reads() >= READS_PER_PASS) this.host.cutPass();
        continue;
      }
      this.host.spendRead();
      const old = await ports.draftFile(fromDoc, draft.branch);
      if (!this.ctx.current()) return 0;
      if (old.kind !== "absent" || (await this.host.leftAlone(looked, from)) !== null) continue;
      activity.ownWrite(from);
      if (!(await ports.vault.trash(from, entry.sha))) {
        activity.notWritten(from);
        this.host.wait(from);
        continue;
      }
      ports.agreed(from, null);
      paths.add(from);
      return 1;
    }
    return 0;
  }
}
