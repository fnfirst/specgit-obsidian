import { gitBlobShaOfText } from "../changes/blob-sha";
import { agreedOf } from "../changes/cache";
import type { Looked } from "../changes/model";
import type { GuardedVault } from "../disk/guarded-vault";
import { CasePathIndex } from "../mapping";
import type { Activity } from "./activity";
import { changeKey, hasOwnOrAgreedRow, isEdit } from "./outbound";
import type { StayData, StayState } from "./state";
import { STAY_HELD } from "./words";

export type HoldReason = NonNullable<StayData["heldWhy"]>[string];

const hasPendingDraft = (looked: Looked, path: string): boolean => {
  const draft = looked.drafts?.byPath.get(path);
  const entry = looked.files.get(path);
  return draft !== undefined && draft.blob !== null && entry?.sent !== undefined && draft.blob !== entry.sent;
};

export const caseCollisionWords = (name: string): string => `${name} on GitHub differs from a note here only in capital letters, so it was not copied in.`;

export const vaultCaseIndex = (looked: Looked, vault: Pick<GuardedVault, "loadedEntries">): CasePathIndex =>
  CasePathIndex.fromPaths(looked.files.keys(), vault.loadedEntries?.());

export interface HoldPorts {
  login(): string;
  inGroup(path: string): boolean;
  now(): number;
  holdsChanged?(): void;
}

const heldKeyForPath = (key: string, path: string): boolean => key.startsWith(`new|${path}|`) || key.startsWith(`renamed|${path}|`);

export class StayHolds {
  private batching = 0;
  private dirty = false;

  constructor(
    private readonly state: StayState,
    private readonly activity: Activity,
    private readonly ports: HoldPorts,
  ) {}

  noteChanged(): void {
    if (this.batching > 0) this.dirty = true;
    else this.ports.holdsChanged?.();
  }

  batch<T>(run: () => T): T {
    this.batching++;
    try {
      return run();
    } finally {
      this.batching--;
      if (this.batching === 0 && this.dirty) {
        this.dirty = false;
        this.ports.holdsChanged?.();
      }
    }
  }

  holdStopped(path: string, text: string): void {
    (this.state.data.editsHeld ??= {})[path] = gitBlobShaOfText(text);
    (this.state.data.heldWhy ??= {})[path] = "stopped";
    this.setFlurryUntil(path, null);
    this.state.save();
    this.noteChanged();
  }

  holdEdit(looked: Looked, path: string, why: HoldReason, options?: { flurryUntil?: number }): boolean {
    const sha = looked.files.get(path)?.sha;
    if (sha === undefined) return false;
    (this.state.data.editsHeld ??= {})[path] = sha;
    (this.state.data.heldWhy ??= {})[path] = why;
    this.setFlurryUntil(path, why === "flurry" ? (options?.flurryUntil ?? null) : null);
    this.noteChanged();
    return hasPendingDraft(looked, path);
  }

  holdNew(looked: Looked, key: string, path: string, why: HoldReason, options?: { flurryUntil?: number; burst?: boolean }): void {
    if (!this.state.data.held.includes(key)) this.state.data.held.push(key);
    if (options?.burst === true && !this.state.data.burst.includes(key)) this.state.data.burst.push(key);
    (this.state.data.heldWhy ??= {})[path] = why;
    const sha = looked.files.get(path)?.sha;
    if (sha !== undefined) (this.state.data.heldShas ??= {})[key] = sha;
    this.setFlurryUntil(path, why === "flurry" ? (options?.flurryUntil ?? null) : null);
    this.noteChanged();
  }

  holdClosedElsewhere(looked: Looked, path: string): boolean {
    const entry = looked.files.get(path);
    if (entry === undefined || entry.sha === looked.repo.get(path)) return false;
    (this.state.data.editsHeld ??= {})[path] = entry.sha;
    (this.state.data.heldWhy ??= {})[path] = "closedElsewhere";
    this.setFlurryUntil(path, null);
    this.noteChanged();
    return true;
  }

  holdEnded(path: string, sha: string): void {
    (this.state.data.editsHeld ??= {})[path] = sha;
    (this.state.data.heldWhy ??= {})[path] = "ended";
    this.setFlurryUntil(path, null);
    this.noteChanged();
  }

  holdDeleted(looked: Looked, path: string, deletedAt: number): boolean {
    const { data } = this.state;
    const entry = looked.files.get(path);
    data.committed = data.committed.filter((key) => key !== changeKey({ kind: "new", path }) && !key.startsWith(`renamed|${path}|`));
    if (!looked.repo.has(path) && !data.held.includes(changeKey({ kind: "new", path }))) data.held.push(changeKey({ kind: "new", path }));
    if (entry) {
      (data.editsHeld ??= {})[path] = entry.sha;
      (data.heldWhy ??= {})[path] = "deleted";
    }
    this.setFlurryUntil(path, null);
    const newlyTold = data.deletedAt?.[path] === undefined;
    (data.deletedAt ??= {})[path] = deletedAt;
    this.noteChanged();
    return newlyTold;
  }

  holdCaseCollision(path: string, key: string): boolean {
    const { data } = this.state;
    const prev = data.caseHeld?.[path];
    if (prev === key) return false;
    (data.caseHeld ??= {})[path] = key;
    this.noteChanged();
    return prev === undefined;
  }

  isCaseHeld(path: string, key?: string): boolean {
    const held = this.state.data.caseHeld?.[path];
    return held !== undefined && (key === undefined || held === key);
  }

  pruneCaseCollisions(looked: Looked, index: CasePathIndex): boolean {
    return this.pruneCaseHeld(
      (path) => index.collision(path) !== null && (looked.repo.has(path) || looked.drafts === undefined || looked.drafts.byPath.has(path)),
    );
  }

  pruneCaseHeld(keep: (path: string) => boolean): boolean {
    const { data } = this.state;
    if (!data.caseHeld) return false;
    let changed = false;
    for (const path of Object.keys(data.caseHeld)) {
      if (!keep(path)) {
        delete data.caseHeld[path];
        changed = true;
      }
    }
    if (Object.keys(data.caseHeld).length === 0) delete data.caseHeld;
    if (changed) this.noteChanged();
    return changed;
  }

  private setFlurryUntil(path: string, until: number | null): void {
    const { data } = this.state;
    if (until === null) {
      if (!data.flurryUntil) return;
      delete data.flurryUntil[path];
      if (Object.keys(data.flurryUntil).length === 0) delete data.flurryUntil;
      return;
    }
    (data.flurryUntil ??= {})[path] = until;
  }

  private expireFlurry(path: string, now: number): boolean {
    const { data } = this.state;
    const flurryAt = data.flurryUntil?.[path];
    if (data.heldWhy?.[path] !== "flurry" || flurryAt === undefined) return false;
    if (this.activity.isGit(path)) {
      this.setFlurryUntil(path, null);
      return false;
    }
    if (this.activity.isSuspect(path)) {
      this.setFlurryUntil(path, Math.max(flurryAt, this.activity.flurryDeadline(path)));
      return false;
    }
    if (now >= flurryAt) {
      this.setFlurryUntil(path, null);
      return true;
    }
    return false;
  }

  nextFlurryAt(): number | null {
    const { data } = this.state;
    if (!data.flurryUntil) return null;
    let earliest: number | null = null;
    for (const [path, at] of Object.entries(data.flurryUntil)) {
      if (data.heldWhy?.[path] !== "flurry") continue;
      if (data.editsHeld?.[path] === undefined && !data.held.some((key) => heldKeyForPath(key, path))) continue;
      earliest = earliest === null ? at : Math.min(earliest, at);
    }
    return earliest;
  }

  restored(path: string): void {
    const { data } = this.state;
    const key = changeKey({ kind: "new", path });
    if (data.deletedAt) delete data.deletedAt[path];
    if (data.heldWhy?.[path] === "deleted") {
      delete data.heldWhy[path];
      delete data.editsHeld?.[path];
    }
    data.held = data.held.filter((one) => one !== key);
    data.burst = data.burst.filter((one) => one !== key);
    delete data.heldShas?.[key];
    this.setFlurryUntil(path, null);
    this.state.save();
    this.noteChanged();
  }

  prune(looked: Looked, committed: ReadonlySet<string>, onUnhold: (key: string) => void): { changed: boolean; releasedFlurry: Set<string> } {
    const { data } = this.state;
    const now = this.ports.now();
    let changed = false;
    const releasedFlurry = new Set<string>();
    for (const [path, sha] of Object.entries(data.editsHeld ?? {})) {
      const entry = looked.files.get(path);
      const draft = looked.drafts?.byPath.get(path);
      const reopened = draft !== undefined && ((draft.by ?? "").toLowerCase() === this.ports.login().toLowerCase() || (entry !== undefined && agreedOf(entry) !== undefined));
      if (data.heldWhy?.[path] === "deleted" && entry !== undefined && data.deletedAt?.[path] !== undefined && draft === undefined && !looked.repo.has(path)) {
        data.editsHeld![path] = entry.sha;
        continue;
      }
      if (data.heldWhy?.[path] === "deleted") delete data.deletedAt?.[path];
      if (data.heldWhy?.[path] === "closedElsewhere" && entry !== undefined && entry.sha !== looked.repo.get(path) && !reopened) {
        data.editsHeld![path] = entry.sha;
        continue;
      }
      const suspect = this.activity.isSuspect(path);
      if (this.expireFlurry(path, now)) {
        delete data.editsHeld![path];
        if (data.heldWhy) delete data.heldWhy[path];
        if (entry !== undefined && entry.sha === sha) releasedFlurry.add(path);
        changed = true;
        continue;
      }
      if (data.heldWhy?.[path] === "closedElsewhere" || entry === undefined) {
        delete data.editsHeld![path];
        if (data.heldWhy) delete data.heldWhy[path];
        this.setFlurryUntil(path, null);
        changed = true;
        continue;
      }
      if (entry.sha !== sha) {
        if (suspect) {
          data.editsHeld![path] = entry.sha;
          changed = true;
        } else {
          delete data.editsHeld![path];
          if (data.heldWhy) delete data.heldWhy[path];
          this.setFlurryUntil(path, null);
          changed = true;
        }
      }
    }
    const rowByKey = new Map(looked.rows.map((row) => [changeKey(row.change), row] as const));
    const keptHeld: string[] = [];
    const heldPaths = new Set<string>();
    for (const key of data.held) {
      const row = rowByKey.get(key);
      if (!row) {
        changed = true;
        continue;
      }
      const path = row.change.path;
      const entry = looked.files.get(path);
      const heldSha = data.heldShas?.[key];
      const deleted = data.heldWhy?.[path] === "deleted" && data.deletedAt?.[path] !== undefined && !looked.repo.has(path);
      const suspect = this.activity.isSuspect(path);
      if (this.expireFlurry(path, now)) {
        delete data.heldShas?.[key];
        onUnhold(key);
        if (entry !== undefined && (heldSha === undefined || entry.sha === heldSha)) releasedFlurry.add(path);
        changed = true;
        continue;
      }
      if (!deleted && heldSha !== undefined && entry !== undefined && entry.sha !== heldSha && !suspect) {
        delete data.heldShas?.[key];
        this.setFlurryUntil(path, null);
        onUnhold(key);
        changed = true;
        continue;
      }
      if (entry !== undefined && (deleted || heldSha === undefined || suspect)) {
        if (heldSha !== entry.sha) changed = true;
        (data.heldShas ??= {})[key] = entry.sha;
      }
      keptHeld.push(key);
      heldPaths.add(path);
    }
    data.held = keptHeld;
    const keptHeldSet = new Set(keptHeld);
    data.burst = data.burst.filter((key) => keptHeldSet.has(key));
    if (data.heldShas) for (const key of Object.keys(data.heldShas)) if (!keptHeldSet.has(key)) delete data.heldShas[key];
    for (const path of Object.keys(data.heldWhy ?? {})) {
      if (data.editsHeld?.[path] === undefined && !heldPaths.has(path)) {
        delete data.heldWhy![path];
        changed = true;
      }
    }
    if (data.flurryUntil) {
      for (const path of Object.keys(data.flurryUntil)) {
        if (data.heldWhy?.[path] !== "flurry" || (data.editsHeld?.[path] === undefined && !heldPaths.has(path))) delete data.flurryUntil[path];
      }
      if (Object.keys(data.flurryUntil).length === 0) delete data.flurryUntil;
    }
    const blockedNew = { baseline: new Set(data.baseline ?? []), held: new Set(data.held), kept: new Set(data.kept) };
    const login = this.ports.login();
    const own = new Set(
      looked.rows.flatMap((row) => {
        const entry = looked.files.get(row.change.path);
        return isEdit(row, committed, { looked, login, blockedNew }) && entry !== undefined && (agreedOf(entry) === undefined || entry.sha !== agreedOf(entry)) ? [row.change.path] : [];
      }),
    );
    for (const path of Object.keys(data.typed ?? {})) if (!own.has(path)) delete data.typed![path];
    if (changed) this.noteChanged();
    return { changed, releasedFlurry };
  }

  isEditHeld(path: string, sha: string): boolean {
    return this.state.data.editsHeld?.[path] === sha;
  }

  advanceEditHold(path: string, fromSha: string, toSha: string): void {
    const { data } = this.state;
    if (data.editsHeld?.[path] !== fromSha) return;
    data.editsHeld[path] = toSha;
    this.state.save();
    this.noteChanged();
  }

  clearEditHold(path: string): void {
    const { data } = this.state;
    if (data.editsHeld?.[path] === undefined) return;
    delete data.editsHeld[path];
    if (data.heldWhy && !data.held.some((key) => heldKeyForPath(key, path))) delete data.heldWhy[path];
    this.setFlurryUntil(path, null);
    this.state.save();
    this.noteChanged();
  }

  recordHeld(
    looked: Looked,
    hold: ReadonlyArray<{ key: string; path: string; edit?: true; atStart?: true }>,
    options: { startReason: "baseline" | "closed"; burst: boolean },
  ): { closedEdits: number; atStartNew: number; arrived: number; pendingDraft: boolean } {
    let closedEdits = 0;
    let atStartNew = 0;
    let arrived = 0;
    let pendingDraft = false;
    const flurryUntil = (path: string, isStart: boolean): number | undefined =>
      !isStart && !options.burst && !this.activity.isGit(path) ? this.activity.flurryDeadline(path) : undefined;
    for (const held of hold) {
      const isStart = held.atStart === true;
      const until = flurryUntil(held.path, isStart);
      if (held.edit === true) {
        if (this.holdEdit(looked, held.path, isStart ? options.startReason : "flurry", until !== undefined ? { flurryUntil: until } : undefined)) pendingDraft = true;
        if (isStart && options.startReason === "closed") closedEdits++;
      } else {
        this.holdNew(looked, held.key, held.path, isStart ? options.startReason : "flurry", { ...(isStart ? {} : { burst: true }), ...(until !== undefined ? { flurryUntil: until } : {}) });
        if (isStart) atStartNew++;
      }
      if (!isStart) arrived++;
    }
    for (const { path } of hold) this.activity.settled(path);
    return { closedEdits, atStartNew, arrived, pendingDraft };
  }

  why(looked: Looked | null, path: string, on: boolean, attachmentNote: string | null): string | null {
    const { data } = this.state;
    const held = data.editsHeld?.[path];
    const reason = data.heldWhy?.[path] ?? "github";
    const own = held !== undefined && looked?.files.get(path)?.sha === held ? (reason === "closedElsewhere" && looked?.drafts?.byPath.has(path) ? STAY_HELD.closedElsewhereNew : STAY_HELD[reason]) : null;
    const row = own === null ? looked?.rows.find((one) => one.change.path === path && (one.change.kind === "new" || one.change.kind === "renamed")) : undefined;
    const onGithub = row !== undefined && hasOwnOrAgreedRow(row, looked, this.ports.login());
    const key = row && !onGithub ? changeKey(row.change) : null;
    const newWhy = data.heldWhy?.[path];
    const heldNew =
      key !== null && data.held.includes(key)
        ? newWhy !== undefined
          ? STAY_HELD[newWhy]
          : data.burst.includes(key)
            ? STAY_HELD.flurry
            : STAY_HELD.held
        : null;
    const baseline = key !== null && heldNew === null && (data.baseline?.includes(key) ?? false) ? STAY_HELD.baseline : null;
    const grouped = on && own === null && heldNew === null && baseline === null && this.ports.inGroup(path) && looked?.drafts?.byPath.get(path)?.inGroup !== true && looked?.rows.some((one) => one.change.path === path && one.change.kind === "edited") === true ? STAY_HELD.group : null;
    const found = on ? (own ?? heldNew ?? baseline ?? grouped) : null;
    const attachments = on ? attachmentNote : null;
    return found !== null && attachments !== null ? `${found} ${attachments}` : (found ?? attachments);
  }
}
