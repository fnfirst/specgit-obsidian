import { noteName } from "../mapping";
import { ACTION_MS, type NoticeHandle } from "../notices";
import type { CacheEntry } from "./cache";
import { closeOneDoomedDraft, closeOneRetiredDraft, type CloseDoomedResult, type DraftCloseHooks } from "./draft-lifecycle";
import type { DoomedDraftRef } from "./draft-lifecycle-store";
import type { FlowDeps } from "./flow-deps";
import type { ChangeRow } from "./model";
import type { SentRecord } from "./sent-memory";
import { closedDraftReviewWords, closingDraftReviewWords, couldntRestoreDraftWords, DELETE_CLOSE_DELAY_MS, UNDO_LABEL } from "./words";

export interface UndoDeleteRecord {
  path: string;
  text: string | null;
  cacheEntry: CacheEntry | null;
  sentRecord: SentRecord | null;
  doomed: DoomedDraftRef | null;
  notice: NoticeHandle | null;
  cancelTimer: (() => void) | null;
  phase: "armed" | "closing" | "retry" | "closed";
}

export interface DraftDeleteHost {
  deps(): FlowDeps;
  stayOn(): boolean;
  hooks(): DraftCloseHooks;
  snapshotText(path: string): string | null;
  sentRecord(path: string): SentRecord | null;
  restoreSentRecord(path: string, record: SentRecord): void;
  forgetMemory(path: string): void;
  resaveAfterUndo(row: ChangeRow): Promise<void>;
}

const OWN_DELETE_SUPPRESS_MS = 5_000;

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = window.setTimeout(fn, ms);
  return () => window.clearTimeout(id);
};

export class DraftDeleteController {
  private readonly closing = new Map<string, Promise<CloseDoomedResult>>();
  private readonly abandoning = new Map<string, { expectPr: number | null; done: Promise<boolean> }>();
  private readonly pendingSupersededRetries = new Set<string>();
  private readonly undos = new Map<string, UndoDeleteRecord>();
  private readonly restoring = new Set<string>();
  private readonly suppressedDeletes = new Map<string, { depth: number; until: number }>();
  private retryingSuperseded = false;
  private closingRetired = false;

  constructor(private readonly host: DraftDeleteHost) {}

  private now(): number {
    return this.host.deps().now?.() ?? Date.now();
  }

  private isSuppressedDelete(path: string): boolean {
    const entry = this.suppressedDeletes.get(path);
    if (!entry) return false;
    if (entry.depth > 0) return true;
    if (entry.until > this.now()) return true;
    this.suppressedDeletes.delete(path);
    return false;
  }

  async suppressLocalDelete<T>(path: string, run: () => Promise<T>, trashed: (result: T) => boolean): Promise<T> {
    const entry = this.suppressedDeletes.get(path) ?? { depth: 0, until: 0 };
    entry.depth += 1;
    this.suppressedDeletes.set(path, entry);
    let succeeded = false;
    try {
      const result = await run();
      succeeded = trashed(result);
      return result;
    } finally {
      entry.depth = Math.max(0, entry.depth - 1);
      if (succeeded) {
        entry.until = Math.max(entry.until, this.now() + OWN_DELETE_SUPPRESS_MS);
      } else if (entry.depth === 0 && entry.until <= this.now()) {
        this.suppressedDeletes.delete(path);
      }
    }
  }

  isClosing(path: string): boolean {
    return this.closing.has(path);
  }

  isRestoringUndo(path: string): boolean {
    return this.restoring.has(path);
  }

  inFlightAbandon(path: string): { expectPr: number | null; done: Promise<boolean> } | undefined {
    return this.abandoning.get(path);
  }

  inFlightClose(path: string): Promise<CloseDoomedResult> | undefined {
    return this.closing.get(path);
  }

  hasPendingSupersededRetries(): boolean {
    return this.pendingSupersededRetries.size > 0;
  }

  private wrappedHooks(): DraftCloseHooks {
    const base = this.host.hooks();
    return {
      clearUploaded: () => base.clearUploaded(),
      forgetMemory: (path) => base.forgetMemory(path),
      onAbandonStart: (path, expectPr, done) => {
        const record = { expectPr, done };
        this.abandoning.set(path, record);
        base.onAbandonStart?.(path, expectPr, done);
        void done.finally(() => {
          if (this.abandoning.get(path) === record) this.abandoning.delete(path);
        });
      },
    };
  }

  noteLocalDelete(path: string, snapshot?: string): void {
    if (this.isSuppressedDelete(path)) return;
    const deps = this.host.deps();
    const existingUndo = this.undos.get(path);
    if (existingUndo && existingUndo.phase !== "closed") {
      if (snapshot !== undefined && existingUndo.text === null) existingUndo.text = snapshot;
      return;
    }
    const cacheEntry = deps.model.cacheEntry(path);
    const sentRecord = this.host.sentRecord(path);
    const text = snapshot ?? this.host.snapshotText(path) ?? sentRecord?.text ?? null;
    this.host.forgetMemory(path);
    if (!this.host.stayOn()) {
      deps.model.noteOfflineOrStayOffDelete(path);
      return;
    }
    const delayMs = deps.deleteCloseDelayMs ?? DELETE_CLOSE_DELAY_MS;
    const doomed = deps.model.noteLiveLocalDelete(path, delayMs > 0);
    if (!doomed.queued) return;

    const record: UndoDeleteRecord = {
      path,
      text,
      cacheEntry: cacheEntry ? { ...cacheEntry } : null,
      sentRecord: sentRecord ? { ...sentRecord } : null,
      doomed: doomed.doomed,
      notice: null,
      cancelTimer: null,
      phase: delayMs > 0 ? "armed" : "closing",
    };
    this.undos.set(path, record);

    const name = noteName(path);
    if (deps.notifyDeleteWithUndo) {
      record.notice = deps.notifyDeleteWithUndo(closingDraftReviewWords(name), UNDO_LABEL, () => void this.undo(path));
    }

    if (delayMs > 0) {
      const schedule = deps.scheduleTimer ?? defaultSchedule;
      record.cancelTimer = schedule(() => {
        record.cancelTimer = null;
        if (this.undos.get(path) !== record || record.phase !== "armed") return;
        if (!this.host.stayOn()) {
          deps.model.cancelLiveDelete(path);
          record.notice?.hide();
          record.notice = null;
          this.undos.delete(path);
          return;
        }
        deps.model.disarmLiveDelete(path);
        void this.runLiveDeleteClose(path, deps);
      }, delayMs);
    } else {
      void this.runLiveDeleteClose(path, deps);
    }
  }

  onLocalCreate(path: string): void {
    this.suppressedDeletes.delete(path);
    if (this.restoring.has(path)) return;
    const record = this.undos.get(path);
    if (record) {
      record.cancelTimer?.();
      record.cancelTimer = null;
      record.notice?.hide();
      record.notice = null;
      this.undos.delete(path);
    }
    const deps = this.host.deps();
    const info = deps.model.doomedDraftFor(path);
    if (info?.kind === "live-delete" && this.host.stayOn()) {
      deps.model.disarmLiveDelete(path);
      void this.closeDoomed(path, deps, { allowArmed: true, refreshOnClose: true });
    }
  }

  private async runLiveDeleteClose(path: string, deps: FlowDeps): Promise<CloseDoomedResult> {
    const record = this.undos.get(path);
    if (record) record.phase = "closing";
    const linkedSources = [...deps.model.draftRenameSources(path)];
    const result = await this.closeDoomed(path, deps, { allowArmed: true, refreshOnClose: true });
    let closedLinked = false;
    if (result.outcome === "done" && !deps.vault.exists(path)) {
      for (const oldPath of linkedSources) {
        if (deps.model.doomedDraftFor(oldPath)?.kind !== "superseded") continue;
        const linked = await this.closeDoomed(oldPath, deps, { allowArmed: true });
        if (linked.closed) closedLinked = true;
      }
    }
    if (this.undos.get(path) === record && record) {
      if (result.outcome === "done") {
        if (result.closed || closedLinked) {
          record.phase = "closed";
          record.notice?.(closedDraftReviewWords(noteName(path)));
          const schedule = deps.scheduleTimer ?? defaultSchedule;
          record.cancelTimer?.();
          record.cancelTimer = schedule(() => {
            record.cancelTimer = null;
            if (this.undos.get(path) === record && record.phase === "closed") {
              this.undos.delete(path);
            }
          }, ACTION_MS);
        } else {
          record.notice?.hide();
          record.notice = null;
          this.undos.delete(path);
        }
      } else {
        record.phase = "retry";
      }
    }
    return result;
  }

  private async resolveRestoreText(path: string, record: UndoDeleteRecord, deps: FlowDeps): Promise<string | null> {
    if (record.text !== null) return record.text;
    const doc = deps.documentFor(path);
    if (!doc) return null;
    const sha = record.doomed?.sha ?? record.cacheEntry?.sent ?? record.cacheEntry?.sha ?? null;
    if (sha !== null) {
      const fromBlob = await deps.gitBlob(doc, sha).catch(() => null);
      if (fromBlob !== null) return fromBlob;
    }
    const branch = record.doomed?.branch ?? null;
    if (branch !== null) {
      const fromBranch = await deps.branchFile(doc, branch).catch(() => ({ kind: "unreadable" as const }));
      if (fromBranch.kind === "file") return fromBranch.text;
    }
    return null;
  }

  private async restoreWithoutResave(path: string, record: UndoDeleteRecord, deps: FlowDeps): Promise<boolean> {
    const text = await this.resolveRestoreText(path, record, deps);
    if (text === null) {
      deps.model.cancelLiveDelete(path);
      deps.dialogs.toast(couldntRestoreDraftWords(noteName(path)));
      return false;
    }
    this.restoring.add(path);
    let made: "created" | "exists" | "failed";
    try {
      made = await deps.vault.create(path, text);
      if (made === "created") {
        deps.model.cancelLiveDelete(path);
        if (record.cacheEntry) deps.model.restoreCacheEntry(path, record.cacheEntry);
        if (record.sentRecord) this.host.restoreSentRecord(path, record.sentRecord);
        deps.model.noteRestoredFromUndo(path);
      }
    } finally {
      this.restoring.delete(path);
    }
    if (made === "exists") return false;
    if (made !== "created") {
      deps.model.cancelLiveDelete(path);
      deps.dialogs.toast(couldntRestoreDraftWords(noteName(path)));
      return false;
    }
    await deps.model.refresh();
    if (record.cacheEntry?.sent !== undefined) {
      deps.model.learnSent(path, record.cacheEntry.sent, (record.cacheEntry.sentTo as never) ?? null, {
        ...(record.cacheEntry.agreed !== undefined ? { agreed: record.cacheEntry.agreed } : {}),
        ...(record.cacheEntry.sentCommit !== undefined ? { commit: record.cacheEntry.sentCommit } : {}),
      });
    }
    return true;
  }

  async undo(path: string): Promise<boolean> {
    const record = this.undos.get(path);
    if (!record) return false;
    const deps = this.host.deps();
    record.cancelTimer?.();
    record.cancelTimer = null;
    record.notice?.hide();
    record.notice = null;
    this.undos.delete(path);

    if (record.phase === "armed" || record.phase === "retry") {
      return this.restoreWithoutResave(path, record, deps);
    }

    if (record.phase === "closing") {
      const inFlight = this.closing.get(path);
      const outcome = inFlight
        ? await inFlight.catch((): CloseDoomedResult => ({ outcome: "retry", closed: false }))
        : ({ outcome: "retry", closed: false } as const);
      if (outcome.outcome === "retry" && !outcome.closed) {
        return this.restoreWithoutResave(path, record, deps);
      }
    }

    const text = await this.resolveRestoreText(path, record, deps);
    if (text === null) {
      deps.dialogs.toast(couldntRestoreDraftWords(noteName(path)));
      return false;
    }
    this.restoring.add(path);
    let made: "created" | "exists" | "failed";
    try {
      made = await deps.vault.create(path, text);
      if (made === "created") {
        deps.model.finishDoomedDraft(path);
        deps.model.noteRestoredFromUndo(path);
      }
    } finally {
      this.restoring.delete(path);
    }
    if (made === "exists") return false;
    if (made !== "created") {
      deps.dialogs.toast(couldntRestoreDraftWords(noteName(path)));
      return false;
    }
    await deps.model.refresh();
    const row = deps.model.row(path);
    if (row) await this.host.resaveAfterUndo(row);
    return true;
  }

  closeDoomed(path: string, deps: FlowDeps = this.host.deps(), options: { allowArmed?: boolean; refreshOnClose?: boolean } = {}): Promise<CloseDoomedResult> {
    const existing = this.closing.get(path);
    if (existing) return existing;
    const run = closeOneDoomedDraft(path, deps, this.wrappedHooks(), options)
      .then((result) => {
        if (this.closing.get(path) === run) this.closing.delete(path);
        if (options.refreshOnClose === true && result.outcome === "done" && deps.vault.exists(path)) void deps.model.refresh();
        return result;
      })
      .catch((err) => {
        if (this.closing.get(path) === run) this.closing.delete(path);
        throw err;
      });
    this.closing.set(path, run);
    return run;
  }

  async closeSupersededFor(newPath: string, deps: FlowDeps = this.host.deps()): Promise<void> {
    const sources = [...deps.model.draftRenameSources(newPath)];
    if (sources.length === 0) {
      this.pendingSupersededRetries.delete(newPath);
      return;
    }
    let needsRetry = false;
    for (const oldPath of sources) {
      if (oldPath === newPath || deps.model.hasRepoFile(oldPath)) {
        deps.model.forgetDraftRenameSource(newPath, oldPath);
        continue;
      }
      const result = await this.closeDoomed(oldPath, deps, { allowArmed: true });
      if (result.outcome === "retry") needsRetry = true;
    }
    if (needsRetry) this.pendingSupersededRetries.add(newPath);
    else this.pendingSupersededRetries.delete(newPath);
  }

  async retrySuperseded(): Promise<void> {
    if (this.retryingSuperseded || this.pendingSupersededRetries.size === 0) return;
    this.retryingSuperseded = true;
    try {
      for (const newPath of [...this.pendingSupersededRetries]) {
        await this.closeSupersededFor(newPath, this.host.deps());
      }
    } finally {
      this.retryingSuperseded = false;
    }
  }

  async closeLateRetired(paths: readonly string[]): Promise<void> {
    if (this.closingRetired || paths.length === 0) return;
    this.closingRetired = true;
    try {
      for (const oldPath of paths) {
        await closeOneRetiredDraft(oldPath, this.host.deps(), this.wrappedHooks());
      }
    } finally {
      this.closingRetired = false;
    }
  }

  async closeReadyLiveDeletes(): Promise<void> {
    if (!this.host.stayOn()) return;
    const deps = this.host.deps();
    const ready = [...deps.model.readyLiveDeletes()].filter((path) => !this.closing.has(path));
    for (const path of ready) {
      if (!this.host.stayOn() || this.closing.has(path)) continue;
      await this.runLiveDeleteClose(path, deps);
    }
  }

  dispose(): void {
    for (const record of this.undos.values()) {
      record.cancelTimer?.();
      record.notice?.hide();
    }
    this.undos.clear();
    this.suppressedDeletes.clear();
  }
}
