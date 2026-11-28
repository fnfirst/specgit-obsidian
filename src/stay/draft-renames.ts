import type { RenamedTarget } from "../auth/git-copy";
import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf, type CacheEntry } from "../changes/cache";
import type { Looked } from "../changes/model";
import { unchangedHere } from "../changes/unchanged-here";
import { type DocumentRef, noteName } from "../mapping";
import { sameLogin } from "../shared/review-flow";
import type { NotePhase } from "../status";
import type { DraftContext } from "./draft-inbound";
import { type Draft, draftKey, draftWriter, follows, isClean, type LeftAlone } from "./draft-state";
import { EMPTY_BLOB, READS_PER_PASS } from "./inbound";
import { changeKey } from "./outbound";
import { BLANK_CANVAS_SHAS } from "./outbound-pass";
import { rewriteCanvasFileRefsOnRename } from "./canvas-rename";
import { DRAFT_SAID } from "./words";

export const RENAME_HOLD_MS = 120_000;
export const RENAME_MISS_TTL_MS = 5 * 60_000;

const TRIVIAL_BOILERPLATE_SHAS: ReadonlySet<string> = new Set([
  EMPTY_BLOB,
  ...BLANK_CANVAS_SHAS,
  ...[
    "\n",
    "\r\n",
    '{"nodes": [], "edges": []}',
    '{"nodes": [], "edges": []}\n',
    '{\n  "nodes": [],\n  "edges": []\n}\n',
    '{\n  "nodes": [],\n  "edges": []\n}\r\n',
    '{\n\t"nodes": [],\n\t"edges": []\n}\n',
    '{\n\t"nodes": [],\n\t"edges": []\n}\r\n',
    '{\n\t"nodes":[],\n\t"edges":[]\n}',
    '{\n\t"nodes":[],\n\t"edges":[]\n}\n',
    "views:\n  - type: table\n    name: Table\n",
    "views:\n  - type: table\n    name: Table",
    "views:\r\n  - type: table\r\n    name: Table\r\n",
    "views:\r\n  - type: table\r\n    name: Table",
    "views: []",
    "views: []\n",
    "views: []\r\n",
  ].map(gitBlobShaOfText),
]);

const isBoilerplateBlob = (blob: string | null): boolean => blob === null || TRIVIAL_BOILERPLATE_SHAS.has(blob);

const isOwnDraftAuthor = (draft: Pick<Draft, "by" | "lastBy">, login: string): boolean =>
  sameLogin(draft.by, login) && (draft.lastBy == null || sameLogin(draft.lastBy, login));

export interface RetiredInboundSource {
  readonly at: number;
  readonly blobs: ReadonlySet<string>;
  readonly prNumber: number | null;
  readonly branch: string | null;
  readonly author: string | null;
}

const prNumberFromSentTo = (sentTo: string | undefined): number | null => {
  if (!sentTo?.startsWith("pr:")) return null;
  const parsed = Number.parseInt(sentTo.slice(3), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const branchFromSentTo = (sentTo: string | undefined): string | null => {
  if (!sentTo?.startsWith("branch:")) return null;
  const branch = sentTo.slice(7);
  return branch !== "" ? branch : null;
};

export const captureRetiredInboundSource = (
  looked: Looked | null,
  path: string,
  now: number,
  renamedDraft?: Pick<Draft, "by" | "lastBy">,
): RetiredInboundSource => {
  const entry = looked?.files.get(path);
  const oldDraft = looked?.drafts?.byPath.get(path);
  const blobs = new Set<string>();
  for (const sha of [entry?.sha, entry?.sent, entry ? agreedOf(entry) : undefined, oldDraft?.blob]) {
    if (typeof sha === "string" && sha !== "") blobs.add(sha);
  }
  const sourceDraft = oldDraft ?? renamedDraft;
  return {
    at: now,
    blobs,
    prNumber: oldDraft?.prNumber ?? prNumberFromSentTo(entry?.sentTo),
    branch: oldDraft?.branch ?? branchFromSentTo(entry?.sentTo),
    author: sourceDraft ? (draftWriter(sourceDraft) ?? sourceDraft.by) : null,
  };
};

export const isFreshDraftAtRetired = (retired: RetiredInboundSource, draft: Draft | undefined): boolean => {
  if (!draft) return false;
  if (retired.prNumber !== null && draft.prNumber !== null && draft.prNumber !== retired.prNumber) return true;
  if (retired.branch !== null && draft.branch !== "" && draft.branch !== retired.branch) return true;
  const nextAuthor = draftWriter(draft) ?? draft.by;
  if (retired.author !== null && nextAuthor !== null && !sameLogin(nextAuthor, retired.author)) return true;
  if (draft.blob !== null && draft.blob !== "" && retired.blobs.size > 0 && !retired.blobs.has(draft.blob)) return true;
  return false;
};

const fileStateOf = (entry: Pick<CacheEntry, "sha" | "sent" | "sentTo">): string => `${entry.sha}\0${entry.sent ?? ""}\0${entry.sentTo ?? ""}`;
const targetKeyOf = (to: string, draft: Pick<Draft, "branch">): string => `${to}\0${draft.branch}`;

const isPublishedBytes = (entry: Pick<CacheEntry, "base">, blob: string | null): boolean => blob !== null && blob !== EMPTY_BLOB && entry.base === blob;

const isRenamedFrom = (draft: Draft, from: string, to: string): boolean => draft.renamedFrom === from || draft.removes?.get(from) === to;
const isRemovedBy = (draft: Draft, from: string): boolean => draft.removes?.get(from) === null;

const isDraftOnly = (looked: Looked, byPath: ReadonlyMap<string, Draft>, from: string, entry: Pick<CacheEntry, "sent">, phase: NotePhase): boolean =>
  !looked.repo.has(from) && !byPath.has(from) && (entry.sent !== undefined || phase === "live");

const isSafeByteOnlyDraftRename = (
  looked: Looked,
  byPath: ReadonlyMap<string, Draft>,
  from: string,
  entry: Pick<CacheEntry, "sent">,
  draft: Pick<Draft, "blob" | "by" | "lastBy">,
  login: string,
  phase: NotePhase,
): boolean =>
  looked.drafts?.level === true &&
  !isBoilerplateBlob(draft.blob) &&
  isOwnDraftAuthor(draft, login) &&
  isDraftOnly(looked, byPath, from, entry, phase);

const bytesMatch = (entry: Pick<CacheEntry, "sha" | "sent" | "base">, blob: string | null): boolean =>
  blob !== null && blob !== EMPTY_BLOB && (entry.sha === blob || entry.sent === blob || isPublishedBytes(entry, blob));

const isCleanRenameSource = (looked: Looked, byPath: ReadonlyMap<string, Draft>, from: string, to: string, entry: CacheEntry, draft: Draft): { exactBlob: boolean; clean: boolean } => {
  const exactBlob = draft.blob !== null && draft.blob !== EMPTY_BLOB && entry.sha === draft.blob;
  if (exactBlob) return { exactBlob: true, clean: true };
  const agreed = agreedOf(entry);
  const sameDraft =
    entry.sent !== undefined &&
    ((!looked.repo.has(from) &&
      (isRenamedFrom(draft, from, to) || (draft.blob !== null && draft.blob !== EMPTY_BLOB && entry.sent === draft.blob))) ||
      (!byPath.has(from) && (entry.sentTo === undefined || entry.sentTo === draftKey(draft))));
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
  private readonly noRenames = new Map<string, { state: string; targets: Set<string>; at: number }>();

  constructor(
    private readonly ctx: DraftContext,
    private readonly host: RenameHost,
  ) {}

  dropSettled(looked: Looked, byPath: ReadonlyMap<string, Draft>): void {
    const now = this.ctx.ports.now();
    for (const path of this.since.keys()) if (!byPath.has(path) || looked.files.has(path)) this.since.delete(path);
    for (const [path, moved] of this.knownRenames) {
      if (!looked.files.has(path) || (byPath.has(path) && looked.repo.has(path))) {
        this.knownRenames.delete(path);
        continue;
      }
      let pending = false;
      for (const to of byPath.keys()) {
        if (!looked.files.has(to) && this.ctx.ports.documentFor(to)?.path === moved.path) {
          pending = true;
          break;
        }
      }
      if (!pending) this.knownRenames.delete(path);
    }
    for (const [path, missed] of this.noRenames) {
      const entry = looked.files.get(path);
      if (!entry || (byPath.has(path) && looked.repo.has(path)) || fileStateOf(entry) !== missed.state || now - missed.at >= RENAME_MISS_TTL_MS) {
        this.noRenames.delete(path);
      }
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

  private cachedRename(
    from: string,
    state: string,
    targetKey: string,
    asked: Map<string, RenamedTarget | null | "unknown">,
  ): { hit: true; value: RenamedTarget | null | "wait" } | { hit: false } {
    const known = this.knownRenames.get(from);
    if (known !== undefined) return { hit: true, value: known };
    if (asked.has(from)) {
      const seen = asked.get(from);
      return { hit: true, value: seen === "unknown" ? "wait" : (seen ?? null) };
    }
    const missed = this.noRenames.get(from);
    if (missed !== undefined && missed.state === state && this.ctx.ports.now() - missed.at < RENAME_MISS_TTL_MS && missed.targets.has(targetKey)) {
      return { hit: true, value: null };
    }
    return { hit: false };
  }

  private async probeRenamedTo(
    from: string,
    entry: Pick<CacheEntry, "sha" | "sent" | "sentTo">,
    fromDoc: DocumentRef,
    targetKey: string,
    allTargets: ReadonlyArray<string>,
    asked: Map<string, RenamedTarget | null | "unknown">,
  ): Promise<RenamedTarget | null | "wait"> {
    const state = fileStateOf(entry);
    const cached = this.cachedRename(from, state, targetKey, asked);
    if (cached.hit) return cached.value;
    if (!this.ctx.ports.renamedTo) return null;
    if (!this.host.ready(from, false, true) || this.host.reads() >= READS_PER_PASS) {
      if (this.host.reads() >= READS_PER_PASS) this.host.cutPass();
      return "wait";
    }
    const now = this.ctx.ports.now();
    this.host.spendRead();
    const moved = await this.ctx.ports.renamedTo(fromDoc);
    if (!this.ctx.current()) return null;
    asked.set(from, moved);
    if (moved === "unknown") {
      this.host.wait(from);
      return "wait";
    }
    if (moved !== null) {
      this.noRenames.delete(from);
      this.knownRenames.set(from, moved);
    } else {
      this.noRenames.set(from, { state, targets: new Set(allTargets), at: now });
    }
    return moved;
  }

  private async findByRenamedToAsync(
    candidates: ReadonlyArray<{ from: string; entry: CacheEntry; fromDoc: DocumentRef; state: string }>,
    startAt: number,
    to: string,
    toDoc: DocumentRef,
    targetKey: string,
    allTargets: ReadonlyArray<string>,
    outPaths: ReadonlySet<string>,
    asked: Map<string, RenamedTarget | null | "unknown">,
  ): Promise<[string, CacheEntry] | null> {
    const { ports } = this.ctx;
    for (let i = startAt; i < candidates.length; i++) {
      const { from, entry, fromDoc } = candidates[i]!;
      if (from === to || outPaths.has(from) || fromDoc.repo !== toDoc.repo) continue;
      if (entry.sent === undefined && ports.phaseOf(from) !== "live") continue;
      const moved = await this.probeRenamedTo(from, entry, fromDoc, targetKey, allTargets, asked);
      if (!this.ctx.current()) return null;
      if (moved === "wait") continue;
      if (moved !== null && moved.path === toDoc.path) return [from, entry];
    }
    return null;
  }

  private findByRenamedTo(
    looked: Looked,
    candidates: ReadonlyArray<{ from: string; entry: CacheEntry; fromDoc: DocumentRef; state: string }>,
    to: string,
    toDoc: DocumentRef,
    draft: Draft,
    allTargets: () => ReadonlyArray<string>,
    outPaths: ReadonlySet<string>,
    asked: Map<string, RenamedTarget | null | "unknown">,
  ): [string, CacheEntry] | null | Promise<[string, CacheEntry] | null> {
    const { ports } = this.ctx;
    if (!ports.renamedTo || !looked.drafts?.level || !follows(draft, ports.login(), undefined, ports.policy())) return null;
    const targetKey = targetKeyOf(to, draft);
    for (let i = 0; i < candidates.length; i++) {
      const { from, entry, fromDoc, state } = candidates[i]!;
      if (from === to || outPaths.has(from) || fromDoc.repo !== toDoc.repo) continue;
      if (entry.sent === undefined && ports.phaseOf(from) !== "live") continue;
      const cached = this.cachedRename(from, state, targetKey, asked);
      if (cached.hit) {
        if (cached.value !== "wait" && cached.value !== null && cached.value.path === toDoc.path) return [from, entry];
        continue;
      }
      return this.findByRenamedToAsync(candidates, i, to, toDoc, targetKey, allTargets(), outPaths, asked);
    }
    return null;
  }

  private isRenameCandidateFollows(looked: Looked, byPath: ReadonlyMap<string, Draft>, to: string, draft: Draft, from: string, entry: CacheEntry): boolean {
    const { ports } = this.ctx;
    if (from === to || ports.inGroup(from) || ports.documentFor(from) === null || this.host.caseCollision(to, from)) return false;
    const known = this.knownRenames.get(from);
    if (known !== undefined && ports.documentFor(to)?.path !== known.path) return false;
    if (isRenamedFrom(draft, from, to)) return true;
    if (isRemovedBy(draft, from)) return draft.blob === null || bytesMatch(entry, draft.blob);
    if (draft.blob !== null && isBoilerplateBlob(draft.blob)) return false;
    if (entry.sent !== undefined && !byPath.has(from)) return true;
    if (isSafeByteOnlyDraftRename(looked, byPath, from, entry, draft, ports.login(), ports.phaseOf(from))) return true;
    return draft.blob !== null && isOwnDraftAuthor(draft, ports.login()) && entry.sent === draft.blob;
  }

  private isRenameCandidate(looked: Looked, byPath: ReadonlyMap<string, Draft>, to: string, draft: Draft, from: string, entry: CacheEntry): boolean {
    const { ports } = this.ctx;
    if (!follows(draft, ports.login(), undefined, ports.policy())) return false;
    return this.isRenameCandidateFollows(looked, byPath, to, draft, from, entry);
  }

  private keepBothOnRename(
    looked: Looked,
    byPath: ReadonlyMap<string, Draft>,
    from: string,
    to: string,
    entry: CacheEntry,
    draft: Draft,
    out: { paths: Set<string> },
  ): void {
    const { ports, state } = this.ctx;
    const token = looked.repo.get(from) ?? state.data.seen?.[from] ?? draft.branch;
    if (state.noteRenameTold(from, to, token, ports.now())) {
      ports.notify(DRAFT_SAID.renameKept(noteName(from), noteName(to)));
    }
    if (!byPath.has(from)) {
      if (entry.sent !== undefined) ports.agreed(from, null);
      this.ctx.clearOwnBlobs?.(from);
      this.host.forgetEnded(from);
      this.host.holdRenamedKept(looked, from);
      this.host.settled(from);
      out.paths.add(from);
    }
  }

  async pair(looked: Looked, byPath: ReadonlyMap<string, Draft>): Promise<{ changed: number; paths: Set<string>; heldFrom: Set<string> }> {
    const { ports, activity, state } = this.ctx;
    const out = { changed: 0, paths: new Set<string>(), heldFrom: new Set<string>() };
    let byBytes: Map<string, Array<[string, CacheEntry]>> | null = null;
    let files: ReadonlyArray<[string, CacheEntry]> | null = null;
    let filesByBlob: Map<string, Array<[string, CacheEntry]>> | null = null;
    type ProbeCandidate = { from: string; entry: CacheEntry; fromDoc: DocumentRef; state: string };
    let probeIndex: {
      unlisted: ProbeCandidate[];
      laggedByBlob: Map<string, ProbeCandidate[]>;
      laggedByBranch: Map<string, ProbeCandidate[]>;
      laggedByPr: Map<number, ProbeCandidate[]>;
    } | null = null;
    let unlistedHoldCandidates: ReadonlyArray<[string, CacheEntry]> | null = null;
    const deletedPaths = looked.deleted.length > 0 ? new Set(looked.deleted.map((gone) => gone.path)) : null;
    const allFiles = (): ReadonlyArray<[string, CacheEntry]> => (files ??= [...looked.files]);
    const indexMatches = (): Map<string, Array<[string, CacheEntry]>> => {
      if (filesByBlob !== null) return filesByBlob;
      filesByBlob = new Map();
      const add = (key: string | null | undefined, pair: [string, CacheEntry]): void => {
        if (!key || key === EMPTY_BLOB) return;
        const list = filesByBlob!.get(key);
        if (!list) filesByBlob!.set(key, [pair]);
        else if (list[list.length - 1] !== pair) list.push(pair);
      };
      for (const pair of allFiles()) {
        const entry = pair[1];
        add(entry.sha, pair);
        add(entry.sent, pair);
        add(entry.base, pair);
      }
      return filesByBlob;
    };
    const getUnlistedHoldCandidates = (): ReadonlyArray<[string, CacheEntry]> => {
      if (unlistedHoldCandidates !== null) return unlistedHoldCandidates;
      const list: Array<[string, CacheEntry]> = [];
      for (const pair of allFiles()) {
        const [from, entry] = pair;
        if (ports.inGroup(from) || ports.documentFor(from) === null) continue;
        if ((entry.sent !== undefined && !byPath.has(from)) || isDraftOnly(looked, byPath, from, entry, ports.phaseOf(from))) {
          list.push(pair);
        }
      }
      unlistedHoldCandidates = list;
      return list;
    };
    const getProbeIndex = () => {
      if (probeIndex !== null) return probeIndex;
      const unlisted: ProbeCandidate[] = [];
      const laggedByBlob = new Map<string, ProbeCandidate[]>();
      const laggedByBranch = new Map<string, ProbeCandidate[]>();
      const laggedByPr = new Map<number, ProbeCandidate[]>();
      const pushMap = <K,>(map: Map<K, ProbeCandidate[]>, key: K, item: ProbeCandidate): void => {
        const list = map.get(key);
        if (!list) map.set(key, [item]);
        else if (list[list.length - 1] !== item) list.push(item);
      };
      for (const [from, entry] of allFiles()) {
        if (ports.inGroup(from)) continue;
        const existingDraft = byPath.get(from);
        if (existingDraft !== undefined) {
          if (looked.repo.has(from) || entry.sent === undefined || (entry.sha !== entry.sent && agreedOf(entry) !== entry.sha)) continue;
          const fromDoc = ports.documentFor(from);
          if (!fromDoc) continue;
          const item: ProbeCandidate = { from, entry, fromDoc, state: fileStateOf(entry) };
          if (entry.sha !== EMPTY_BLOB) pushMap(laggedByBlob, entry.sha, item);
          if (entry.sent !== EMPTY_BLOB) pushMap(laggedByBlob, entry.sent, item);
          if (existingDraft.branch !== "") pushMap(laggedByBranch, existingDraft.branch, item);
          if (existingDraft.prNumber !== null) pushMap(laggedByPr, existingDraft.prNumber, item);
          continue;
        }
        if (entry.sent === undefined && looked.repo.has(from)) continue;
        const fromDoc = ports.documentFor(from);
        if (!fromDoc) continue;
        unlisted.push({ from, entry, fromDoc, state: fileStateOf(entry) });
      }
      probeIndex = { unlisted, laggedByBlob, laggedByBranch, laggedByPr };
      return probeIndex;
    };
    const getProbeCandidatesFor = (draft: Draft): ReadonlyArray<ProbeCandidate> => {
      const idx = getProbeIndex();
      const byBlob = draft.blob !== null && draft.blob !== EMPTY_BLOB ? idx.laggedByBlob.get(draft.blob) : undefined;
      const byBranch = draft.branch !== "" ? idx.laggedByBranch.get(draft.branch) : undefined;
      const byPr = draft.prNumber !== null ? idx.laggedByPr.get(draft.prNumber) : undefined;
      if (!byBlob && !byBranch && !byPr) return idx.unlisted;
      const combined: ProbeCandidate[] = [...idx.unlisted];
      const added = new Set<string>(idx.unlisted.map((c) => c.from));
      for (const group of [byBlob, byBranch, byPr]) {
        if (!group) continue;
        for (const item of group) {
          if (added.has(item.from)) continue;
          added.add(item.from);
          combined.push(item);
        }
      }
      return combined;
    };
    let allTargets: ReadonlyArray<string> | null = null;
    const unmatchedTargets = (): ReadonlyArray<string> =>
      (allTargets ??= [...byPath]
        .filter(([path]) => !looked.files.has(path) && !looked.repo.has(path) && !(deletedPaths?.has(path) ?? false) && !ports.inGroup(path))
        .map(([path, one]) => targetKeyOf(path, one)));
    const askedRenames = new Map<string, RenamedTarget | null | "unknown">();
    for (const [to, draft] of byPath) {
      if (!this.ctx.current()) break;
      if (looked.files.has(to)) {
        byBytes ??= indexByBytes(looked.files);
        out.changed += await this.repairPair(looked, byPath, byBytes, to, draft, out.paths);
        continue;
      }
      if (looked.repo.has(to) || (deletedPaths?.has(to) ?? false) || ports.inGroup(to)) continue;
      const hold = (specificFrom?: string): void => {
        const since = this.since.get(to);
        if (since !== undefined && ports.now() - since > RENAME_HOLD_MS) return;
        if (specificFrom !== undefined) {
          if (!this.mayBeRename(looked, byPath, to, draft) || !this.holding(to)) return;
          out.paths.add(to);
          if (!byPath.has(specificFrom)) out.heldFrom.add(specificFrom);
          return;
        }
        if (!follows(draft, ports.login(), undefined, ports.policy())) return;
        let hasCandidate = false;
        let held = false;
        const checked = new Set<string>();
        const checkCandidate = (candidate: string, candidateEntry: CacheEntry): boolean => {
          if (checked.has(candidate)) return true;
          checked.add(candidate);
          if (!this.isRenameCandidateFollows(looked, byPath, to, draft, candidate, candidateEntry)) return true;
          if (!hasCandidate) {
            hasCandidate = true;
            if (!this.holding(to)) return false;
            held = true;
            out.paths.add(to);
          }
          if (!byPath.has(candidate)) out.heldFrom.add(candidate);
          return true;
        };
        if (draft.renamedFrom !== undefined) {
          const e = looked.files.get(draft.renamedFrom);
          if (e && !checkCandidate(draft.renamedFrom, e)) return;
        }
        if (draft.removes) {
          for (const removedFrom of draft.removes.keys()) {
            const e = looked.files.get(removedFrom);
            if (e && !checkCandidate(removedFrom, e)) return;
          }
        }
        if (draft.blob !== null && draft.blob !== EMPTY_BLOB) {
          for (const [candidate, candidateEntry] of indexMatches().get(draft.blob) ?? []) {
            if (!checkCandidate(candidate, candidateEntry)) return;
          }
        }
        for (const [candidate, candidateEntry] of getUnlistedHoldCandidates()) {
          if (!checkCandidate(candidate, candidateEntry)) return;
        }
        if (!held) return;
      };
      if (draft.blob === null) {
        hold();
        continue;
      }
      const eligible = ([from]: [string, CacheEntry]): boolean => from !== to && !out.paths.has(from) && ports.documentFor(from) !== null && !ports.inGroup(from);
      let found =
        (draft.renamedFrom !== undefined || (draft.removes && draft.removes.size > 0)
          ? allFiles().find((pair) => eligible(pair) && isRenamedFrom(draft, pair[0], to))
          : undefined) ??
        (draft.blob !== EMPTY_BLOB
          ? indexMatches()
              .get(draft.blob)
              ?.find(
                ([from, entry]) =>
                  eligible([from, entry]) &&
                  (isRemovedBy(draft, from) || isSafeByteOnlyDraftRename(looked, byPath, from, entry, draft, ports.login(), ports.phaseOf(from))),
              )
          : undefined);
      if (!found && ports.renamedTo && looked.drafts?.level) {
        const toDoc = ports.documentFor(to);
        if (toDoc) {
          const candidates = getProbeCandidatesFor(draft);
          if (candidates.length > 0) {
            const resolved = this.findByRenamedTo(looked, candidates, to, toDoc, draft, unmatchedTargets, out.paths, askedRenames);
            const matched = resolved instanceof Promise ? await resolved : resolved;
            if (!this.ctx.current()) break;
            if (matched !== null) found = matched;
          }
        }
      }
      if (!found) {
        hold();
        continue;
      }
      const [from, entry] = found;
      const [fromDoc, toDoc] = [ports.documentFor(from), ports.documentFor(to)];
      if (!fromDoc || !toDoc || !follows(draft, ports.login(), undefined, ports.policy())) continue;
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
      const { exactBlob, clean } = isCleanRenameSource(looked, byPath, from, to, entry, draft);
      if (!clean) {
        const left = await this.host.leftAlone(looked, from, { transientOnly: true });
        if (!this.ctx.current()) break;
        if (left !== null && this.holding(to)) {
          if (left === "unsaved") this.host.deferUnsaved(from);
          out.paths.add(to);
          if (!byPath.has(from)) out.heldFrom.add(from);
          continue;
        }
        this.keepBothOnRename(looked, byPath, from, to, entry, draft, out);
        continue;
      }
      const left = await this.host.leftAlone(looked, from, { allowLive: true });
      if (!this.ctx.current()) break;
      if (left !== null) {
        if (this.holding(to)) {
          if (left === "unsaved") this.host.deferUnsaved(from);
          out.paths.add(to);
          if (!byPath.has(from)) out.heldFrom.add(from);
          continue;
        }
        this.keepBothOnRename(looked, byPath, from, to, entry, draft, out);
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
      if (from !== to && !looked.repo.has(from)) ports.forgetDelete(from);
      this.host.noteRenamed(from, to);
      this.ctx.renameOwnBlobs?.(from, to);
      state.data.committed.push(changeKey({ kind: "new", path: to }), changeKey({ kind: "renamed", path: to, from }));
      ports.agreed(from, null);
      this.host.forgetEnded(from);
      this.host.settled(from);
      const awaitingSent = exactBlob ? draft.blob : (entry.sent ?? entry.base ?? entry.sha);
      this.host.awaiting.set(to, { sent: awaitingSent, to: draftKey(draft), agreed: entry.sha });
      const updatedCanvases = looked.repo.has(from) ? 0 : await rewriteCanvasFileRefsOnRename(ports.vault, activity, state, ports.now(), from, to);
      out.paths.add(from);
      out.paths.add(to);
      out.changed += 1 + updatedCanvases;
    }
    return out;
  }

  mayBeRename(looked: Looked, byPath: ReadonlyMap<string, Draft>, to: string, draft: Draft): boolean {
    const { ports } = this.ctx;
    if (!follows(draft, ports.login(), undefined, ports.policy())) return false;
    for (const [from, entry] of looked.files) {
      if (this.isRenameCandidateFollows(looked, byPath, to, draft, from, entry)) return true;
    }
    return false;
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
      if (!follows(draft, ports.login(), undefined, ports.policy())) continue;
      if (isRenamedFrom(draft, path, to)) return true;
      const toDoc = ports.documentFor(to);
      if (fromDoc && toDoc && knownTarget !== undefined && knownTarget === toDoc.path) return true;
      if ((isRemovedBy(draft, path) || isSafeByteOnlyDraftRename(looked, byPath, path, entry, draft, ports.login(), ports.phaseOf(path))) && bytesMatch(entry, draft.blob)) return true;
      if ((draft.blob === null || (!looked.repo.has(to) && isSafeByteOnlyDraftRename(looked, byPath, path, entry, draft, ports.login(), ports.phaseOf(path)))) && (this.since.get(to) ?? now) + RENAME_HOLD_MS >= now) return true;
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
    const toDoc = ports.documentFor(to);
    for (const [from, entry] of byBytes.get(at.sha) ?? []) {
      const removed = isRenamedFrom(draft, from, to) || isRemovedBy(draft, from);
      const provenDraftRename = !looked.repo.has(from) && toDoc !== null && this.knownRenames.get(from)?.path === toDoc.path;
      if (from === to || (!removed && !provenDraftRename) || paths.has(from) || ports.inGroup(from)) continue;
      if (entry.sent === undefined && at.sha !== draft.blob) continue;
      const fromDoc = ports.documentFor(from);
      const { clean } = isCleanRenameSource(looked, byPath, from, to, entry, draft);
      if (!fromDoc || !follows(draft, ports.login(), undefined, ports.policy()) || !clean) continue;
      const probed = await this.probeAbsent(from, fromDoc, draft.branch);
      if (!this.ctx.current()) return 0;
      if (probed !== "absent" || (await this.host.leftAlone(looked, from)) !== null) continue;
      activity.ownWrite(from);
      if (!(await ports.vault.trash(from, entry.sha))) {
        activity.notWritten(from);
        this.host.wait(from);
        continue;
      }
      if (!looked.repo.has(from)) ports.forgetDelete(from);
      this.host.noteRemoved(from);
      const updatedCanvases = looked.repo.has(from) ? 0 : await rewriteCanvasFileRefsOnRename(ports.vault, activity, this.ctx.state, ports.now(), from, to);
      ports.agreed(from, null);
      this.ctx.clearOwnBlobs?.(from);
      this.host.forgetEnded(from);
      this.host.settled(from);
      paths.add(from);
      return 1 + updatedCanvases;
    }
    return 0;
  }
}
