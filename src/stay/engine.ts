import type { Looked } from "../changes/model";
import { LOST_ANSWER_DESCRIPTION, LOST_ANSWER_TITLE } from "../shared/review-flow";
import { Activity } from "./activity";
import { type AttachmentProblem, StayAttachments } from "./attachments";
import { DraftOffers, FirstLook } from "./aware-steps";
import { DraftInbound, UNSAVED_WAITS_MS } from "./draft-inbound";
import { type Draft, follows, type StayDrafts } from "./draft-state";
import { DRAFT_SAID, STAY_SAID as SAID } from "./words";
import type { GitObservation } from "./git-watch";
import { StayHolds } from "./holds";
import { Inbound } from "./inbound";
import { missingNotes } from "../changes/missing-notes";
import { WRITES_PER_FILE } from "../changes/burst";
import { Pace, WriteBudget } from "./limits";
import { type BlockedNew, changeKey, hasOwnOrAgreedDraft, isEdit, planOutbound } from "./outbound";
import { buildEditRules, copyBusyPaths, filterRowsForPartial, flushHeardQueue, groupBurstFiles, inboundActivePaths, isBlankLocalUntitled, isFreshLocalUntitled, keepMissingBases, keptPathsReadOnly, LIVE_HEARD_PER_PASS, observeStayGit, pruneSentRecently, pruneStayLists, recordTypedTouch, refreshGithubHolds, RETRY_WAITS_MS, sendPlannedOutbound, stepBackoff, syncKeptPaths, UNSURE_RETRY_MS } from "./outbound-pass";
import { OwnBlobs } from "./own-blobs";
import { RoomWrites } from "./room-writes";
import type { StayGitMark, StayState } from "./state";
import type { StayPorts } from "./types";
import { WAKE_PAD_MS } from "./wait";

export const HEARD_MS = 1_500;
export const ENDED_WATCH_MS = 65_000;
export { LIVE_HEARD_PER_PASS, RETRY_WAITS_MS, UNSURE_RETRY_MS };
const MORE_MS = 2_000;
const TRIES = 3;

const QUIT_GRACE_MS = 5_000;

const SAVE_SOON_MS = 5_000;

type Timer = "inbound" | "outbound" | "edits" | "drafts" | "flurry";

export class StayConnected {
  private on = false;
  private generation = 0;
  private looked: Looked | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private copying: { generation: number; paths: Set<string>; lower: Set<string> } | null = null;
  private copyOutbound: Promise<void> | null = null;
  private copyOutboundAgain = false;
  private inbound: Inbound | null = null;
  private bringer: Inbound | null = null;
  private draftIn: DraftInbound | null = null;
  private readonly pace: Pace;
  private readonly holds: StayHolds;
  private readonly attachments: StayAttachments;
  private readonly roomWrites: RoomWrites;
  private readonly ownBlobs: OwnBlobs;
  private readonly conflicts = new Map<string, string>();
  private readonly githubHeldBase = new Map<string, string | null>();
  private readonly timers = new Map<Timer, { cancel: () => void; at: number }>();
  private readonly heard = new Map<string, () => void>();
  private readonly heardLater = new Set<string>();
  private readonly heardAwaitingLook = new Set<string>();
  private readonly sentRecently = new Map<string, number>();
  private saving: (() => void) | null = null;
  private readonly typedReads = new Map<string, () => void>();
  private readonly heardShas = new Map<string, { waiting: Set<string>; read: string[] }>();
  private readonly endWatch = new Map<string, () => void>();
  private away: { count: number } | null = null;
  private readonly retryAt = new Map<string, number>();
  private readonly tries = new Map<string, number>();
  private readonly laterTries = new Map<string, { count: number; generation: number }>();
  private readonly outboundUnsaved = new Map<string, { strikes: number; until: number }>();
  private readonly basesTried = new Set<string>();
  private readonly releasedAtStart = new Set<string>();
  private startedOutbound = false;
  private startedEdits = false;
  private gitChecked = false;
  private gitMovedAtStart = false;
  private pendingGitMark: StayGitMark | null = null;
  private beganAt = 0;
  private grouping = false;
  private readonly firstLook = new FirstLook();
  private readonly offers = new DraftOffers({
    draftIn: (current) => this.draftInbound(current),
    existing: () => this.draftIn,
    on: () => this.on,
    looked: () => this.looked,
    phaseOf: (path) => this.ports.phaseOf(path),
  });

  private draftInbound(current: () => boolean): DraftInbound {
    return (this.draftIn ??= new DraftInbound({
      ports: this.ports,
      state: this.state,
      activity: this.activity,
      holds: this.holds,
      isRemoteRoom: (path, sha) => this.roomWrites.matches(path, sha),
      isRemoteRoomBlob: (path, diskSha, draftBlob) => this.roomWrites.matchesPair(path, diskSha, draftBlob),
      noteOwnBlob: (path, sha) => this.ownBlobs.recordSha(path, sha),
      clearOwnBlobs: (path) => this.ownBlobs.clear(path),
      renameOwnBlobs: (from, to) => this.ownBlobs.renamed(from, to),
      consumeRebasedSent: (path, sha) => this.ownBlobs.consumeRebasedSent(path, sha),
      hasConflict: (path, looked) => this.conflicts.get(path) === this.conflictKey(looked, path),
      onResolved: (path) => this.draftConflictResolved(path),
      sentSinceLook: () => this.sentRecently.keys(),
      ...(this.options?.quietWaitMs ? { quietWaitMs: this.options.quietWaitMs } : {}),
      current,
    }));
  }

  constructor(
    private readonly ports: StayPorts,
    private readonly state: StayState,
    readonly activity: Activity,
    private readonly budget: WriteBudget,
    private readonly options?: { quietWaitMs?: () => number },
  ) {
    this.pace = new Pace(budget, () => ports.now());
    this.holds = new StayHolds(state, activity, ports);
    this.roomWrites = new RoomWrites(state, () => this.saveSoon());
    this.ownBlobs = new OwnBlobs(state, () => this.saveSoon());
    this.attachments = new StayAttachments({
      ports,
      state,
      activity,
      budget,
      on: () => this.on,
      generation: () => this.generation,
      current: (generation) => this.current(generation),
      looked: () => this.looked,
      saveSoon: () => this.saveSoon(),
    });
  }

  isOn(): boolean {
    return this.on;
  }

  private observeGit(obs: GitObservation | null, atStart: boolean): boolean {
    const res = observeStayGit(obs, atStart, this.state, this.activity, this.pendingGitMark);
    this.pendingGitMark = res.pendingGitMark;
    if (res.movedAtStart) this.gitMovedAtStart = true;
    return res.moved;
  }

  async pollGit(): Promise<boolean> {
    if (!this.on || !this.ports.git || !this.gitChecked) return false;
    const generation = this.generation;
    const res = await this.ports.git.poll().catch(() => null);
    if (!this.current(generation)) return false;
    return this.observeGit(res, false);
  }

  enable(): void {
    if (this.on) return;
    this.on = true;
    this.beganAt = this.ports.now();
    this.generation++;
    this.activity.listener = (path, deferRead, from) => this.typing(path, deferRead, from);
    this.activity.remoteCheck = (path, sha) => this.roomWrites.matches(path, sha);
    this.activity.onRename = (from, to) => {
      this.roomWrites.renamed(from, to);
      this.ownBlobs.renamed(from, to);
    };
    this.attachments.restore();
    this.ports.lookAgain();
  }

  roomWrote(path: string, text: string | null): void {
    if (!this.on && text !== null) return;
    if (text !== null) {
      this.typedReads.get(path)?.();
      this.typedReads.delete(path);
    }
    this.roomWrites.record(path, text);
  }

  roomAcked(path: string, text: string, pin = false): void {
    if (!this.on) return;
    if (pin) this.ownBlobs.pinText(path, text);
    else this.ownBlobs.recordText(path, text, this.looked?.files.get(path)?.base);
  }

  hasLocalEdit(path: string, text: string): boolean {
    return this.roomWrites.hasLocalEdit(this.looked, path, text);
  }

  private typing(path: string, deferRead = false, from?: string): void {
    if (!this.on || this.activity.isSuspect(path)) return;
    if (from !== undefined) {
      this.typedReads.get(from)?.();
      this.typedReads.delete(from);
    }
    if (this.ports.phaseOf(path) !== "local" && this.roomWrites.has(path)) return;
    const generation = this.generation;
    if (this.copying?.generation === generation && !this.copying.lower.has(path.toLowerCase())) {
      this.sooner("outbound", this.activity.quietInFor(path, from) + WAKE_PAD_MS, () => this.wakeOutbound(generation));
    }
    recordTypedTouch({
      path,
      deferRead,
      ...(from !== undefined ? { from } : {}),
      state: this.state,
      ports: this.ports,
      typedReads: this.typedReads,
      isCurrent: () => this.current(generation),
      isSuspect: (one) => this.activity.isSuspect(one),
      isRemoteRoom: (one, sha) => this.roomWrites.matches(one, sha),
      saveSoon: () => this.saveSoon(),
    });
  }

  flush(): void {
    let hadPending = false;
    if (this.saving !== null) {
      this.saving();
      this.saving = null;
      hadPending = this.on;
    }
    this.state.flush(hadPending);
  }

  private saveSoon(): void {
    if (this.saving !== null) return;
    this.saving = this.ports.later(() => {
      this.saving = null;
      this.state.save();
    }, SAVE_SOON_MS);
  }

  stop(): void {
    this.flush();
    this.on = false;
    this.offers.reset();
    this.activity.listener = null;
    this.activity.remoteCheck = null;
    this.activity.onRename = null;
    this.generation++;
    for (const entry of this.timers.values()) entry.cancel();
    this.timers.clear();
    this.inbound?.stop();
    this.inbound = null;
    this.bringer?.stop();
    this.bringer = null;
    this.draftIn?.stop();
    this.draftIn = null;
    this.conflicts.clear();
    this.githubHeldBase.clear();
    this.ownBlobs.stop();
    for (const cancel of this.heard.values()) cancel();
    this.heard.clear();
    for (const cancel of this.typedReads.values()) cancel();
    this.typedReads.clear();
    for (const cancel of this.endWatch.values()) cancel();
    this.endWatch.clear();
    this.heardLater.clear();
    this.heardAwaitingLook.clear();
    this.sentRecently.clear();
    this.heardShas.clear();
    this.attachments.stop();
    this.away = null;
    this.looked = null;
    this.retryAt.clear();
    this.tries.clear();
    this.laterTries.clear();
    this.outboundUnsaved.clear();
    this.basesTried.clear();
    this.releasedAtStart.clear();
    this.startedOutbound = false;
    this.startedEdits = false;
    this.gitChecked = false;
    this.gitMovedAtStart = false;
    this.pendingGitMark = null;
  }

  isKept(path: string): boolean {
    return this.on && this.state.data.kept.includes(path);
  }

  disable(): void {
    if (!this.on) return;
    this.stop();
    this.state.clear();
  }

  lookedAt(looked: Looked | null): void {
    this.looked = looked;
    if (!this.on || looked === null) return;
    pruneSentRecently(this.sentRecently, looked, this.ports.now());
    if (looked.drafts && this.ports.signedIn()) {
      const generation = this.generation;
      this.draftInbound(() => this.current(generation)).noteInitial(looked);
      for (const path of [...this.heardAwaitingLook]) {
        if (looked.drafts.byPath.has(path)) {
          this.heardAwaitingLook.delete(path);
          this.heardLater.add(path);
        }
      }
    }
    if (this.running) {
      this.again = true;
      if (this.copying?.generation === this.generation) this.runCopyOutbound(this.copying.generation);
      return;
    }
    this.track(this.pass());
  }

  private wakeOutbound(generation: number): void {
    if (!this.current(generation)) return;
    if (this.copying?.generation === generation) this.runCopyOutbound(generation);
    this.ports.lookAgain();
  }

  private runCopyOutbound(generation: number): void {
    if (this.copyOutbound) return void (this.copyOutboundAgain = true);
    this.copyOutbound = (async () => {
      try {
        while (this.current(generation) && this.copying?.generation === generation) {
          this.copyOutboundAgain = false;
          const looked = this.looked;
          if (!looked || !this.ports.signedIn() || this.ports.personBusy()) return;
          const busyPaths = copyBusyPaths(looked, this.state.data, this.copying.paths, this.copying.lower, {
            committed: new Set(this.state.data.committed),
            login: this.ports.login(),
            now: this.ports.now(),
            inGroup: (path) => this.ports.inGroup(path),
            policyFor: (path, draft) => this.policyFor(path, draft),
            isRemoteRoom: (path, sha) => this.roomWrites.matches(path, sha),
          });
          const sent = await this.outbound(looked, generation, { busyPaths });
          if (sent && this.current(generation) && this.copying?.generation === generation) this.ports.lookAgain();
          if (!this.copyOutboundAgain) return;
        }
      } finally {
        this.copyOutbound = null;
        this.copyOutboundAgain = false;
      }
    })();
  }

  private canRunHeard(): boolean {
    return this.ports.signedIn() && !this.ports.personBusy() && !this.ports.hidden() && !this.ports.offline();
  }

  private markHeardShasRead(path: string): void {
    const shas = this.heardShas.get(path);
    if (!shas) return;
    shas.read = [...shas.read, ...shas.waiting].slice(-8);
    shas.waiting.clear();
  }

  private flushHeardDrafts(looked: Looked, generation: number, draftIn: DraftInbound, handled?: Set<string>): Promise<{ changed: number; rescan: boolean }> {
    return flushHeardQueue({
      getLooked: () => this.looked ?? looked,
      sentRecently: this.sentRecently,
      heardLater: this.heardLater,
      heardAwaitingLook: this.heardAwaitingLook,
      ...(handled ? { handled } : {}),
      isCurrent: () => this.current(generation),
      canRun: () => this.canRunHeard(),
      policy: () => this.ports.policy(),
      markShasRead: (path) => this.markHeardShasRead(path),
      readOne: (cur, path) => draftIn.readOne(cur, path),
      onWake: (wake) => this.sooner("drafts", wake, () => this.ports.lookAgain()),
      onDiagnose: () => this.ports.diagnose("a draft that the events named could not be read"),
    });
  }

  private drainHeardLater(generation: number): void {
    const looked = this.looked;
    if (!looked || !this.current(generation) || !this.canRunHeard()) return;
    const draftIn = this.draftInbound(() => this.current(generation));
    this.track(
      (async () => {
        const done = await this.flushHeardDrafts(looked, generation, draftIn);
        if (this.current(generation) && (done.changed > 0 || done.rescan)) this.ports.lookAgain();
      })(),
    );
  }

  private track(work: Promise<void>): void {
    this.running = work.finally(() => {
      this.running = null;
      const generation = this.generation;
      if (!this.current(generation)) return;
      if (this.again) {
        this.again = false;
        if (this.looked) {
          this.lookedAt(this.looked);
          return;
        }
      }
      if (this.heardLater.size > 0 && this.looked && this.canRunHeard()) {
        this.drainHeardLater(generation);
      }
    });
  }

  async holdStopped(path: string): Promise<void> {
    if (!this.on) return;
    this.ownBlobs.clear(path);
    const text = await this.ports.vault.read(path);
    if (text === null || !this.on) return;
    this.holds.holdStopped(path, text);
  }

  deletedOnGithub(path: string, at: number): void {
    const looked = this.looked;
    if (!this.on || !looked || !looked.files.has(path)) return;
    const draftIn = this.draftInbound(() => this.on);
    draftIn.keepDeleted(looked, path, at);
    draftIn.tellDeleted();
    this.state.save();
  }

  deletedAt(path: string): number | null {
    return this.state.data.deletedAt?.[path] ?? null;
  }

  restored(path: string): void {
    this.draftIn?.forgetDeleted(path);
    this.holds.restored(path);
    this.ownBlobs.clear(path);
  }

  returned(): void {
    if (!this.on) return;
    this.away = { count: 0 };
    this.ports.lookAgain();
  }

  heardDraft(path: string, wait = HEARD_MS, generation = this.generation, sha?: string): void {
    if (!this.on || generation !== this.generation || this.ports.hidden()) return;
    if (sha !== undefined) {
      const shas = this.heardShas.get(path) ?? { waiting: new Set<string>(), read: [] };
      this.heardShas.set(path, shas);
      if (shas.read.includes(sha)) return;
      shas.waiting.add(sha);
    }
    this.heard.get(path)?.();
    this.heard.set(
      path,
      this.ports.later(() => {
        this.heard.delete(path);
        void this.readHeard(path, generation);
      }, wait),
    );
  }

  heardReview(branch: string, wait = ENDED_WATCH_MS, generation = this.generation): void {
    const looked = this.looked;
    if (!this.on || generation !== this.generation || !looked?.drafts || this.ports.hidden()) return;
    for (const [path, draft] of looked.drafts.byPath) {
      if (draft.branch !== branch) continue;
      this.endWatch.get(path)?.();
      this.endWatch.set(
        path,
        this.ports.later(() => {
          this.endWatch.delete(path);
          void this.readEnded(path, generation);
        }, wait),
      );
    }
  }

  private async readEnded(path: string, generation: number): Promise<void> {
    if (!this.current(generation) || !this.ports.signedIn() || this.ports.hidden()) return;
    if (this.running || this.ports.personBusy()) return void this.heardReviewAgain(path, generation);
    const looked = this.looked;
    if (!looked || this.ports.offline()) return;
    const draftIn = this.draftInbound(() => this.current(generation));
    this.track(
      (async () => {
        try {
          const done = await draftIn.readEnded(looked, path);
          if (!this.current(generation)) return;
          if (done.wake !== null) this.sooner("drafts", done.wake, () => this.ports.lookAgain());
          if (done.changed > 0 || done.rescan) this.ports.lookAgain();
        } catch {
          this.ports.diagnose("a review that the events named could not be read");
        }
      })(),
    );
  }

  private heardReviewAgain(path: string, generation: number): void {
    this.endWatch.set(
      path,
      this.ports.later(() => {
        this.endWatch.delete(path);
        void this.readEnded(path, generation);
      }, 2_000),
    );
  }

  private async readHeard(path: string, generation: number): Promise<void> {
    if (!this.current(generation) || !this.ports.signedIn() || this.ports.personBusy() || this.ports.hidden()) return;
    if (this.running) {
      this.heardLater.add(path);
      return;
    }
    const looked = this.looked;
    if (!looked || this.ports.offline()) return;
    if (this.ports.policy() === "mine") {
      this.markHeardShasRead(path);
      return this.ports.lookAgain();
    }
    const known =
      looked.drafts?.byPath.has(path) === true ||
      (looked.files.get(path)?.sent !== undefined && !this.sentRecently.has(path)) ||
      looked.rows.some((one) => one.change.path === path && one.review?.reviewBranch != null);
    if (!known) {
      this.heardAwaitingLook.add(path);
      return this.ports.lookAgain();
    }
    this.heardAwaitingLook.delete(path);
    const draftIn = this.draftInbound(() => this.current(generation));
    this.track(
      (async () => {
        try {
          const done = await draftIn.readOne(looked, path);
          if (!this.current(generation)) return;
          this.markHeardShasRead(path);
          if (done.wake !== null) this.sooner("drafts", done.wake, () => this.ports.lookAgain());
          if (done.changed > 0 || done.rescan) this.ports.lookAgain();
        } catch {
          this.ports.diagnose("a draft that the events named could not be read");
        }
      })(),
    );
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private current(generation: number): boolean {
    return this.on && this.generation === generation && this.ports.enabled();
  }

  private async pass(): Promise<void> {
    const generation = this.generation;
    const looked = this.looked;
    if (!looked || !this.ports.signedIn() || this.ports.personBusy()) return;
    this.roomWrites.prune(looked, (path) => this.ports.phaseOf(path));
    const { data } = this.state;
    if (data.seen === null || data.baseline === null) {
      data.baselinePending = true;
      data.seen = Object.fromEntries([...looked.repo].map(([path, sha]) => [path, looked.files.get(path)?.base ?? sha]));
      data.guessed = [...looked.repo.keys()].filter((path) => (looked.files.get(path)?.base ?? null) === null);
      const login = this.ports.login();
      data.baseline = looked.rows
        .filter((row) => !hasOwnOrAgreedDraft(looked.files.get(row.change.path), looked.drafts?.byPath.get(row.change.path), login))
        .map((row) => changeKey(row.change));
      this.state.save();
      this.firstLook.begin();
      const absent = missingNotes(looked.repo.keys(), looked.files.keys(), looked.deleted.map((gone) => gone.path));
      const missing = absent.copy.flatMap((path) => {
        const doc = this.ports.documentFor(path);
        return doc ? [{ path, doc }] : [];
      });
      if (missing.length > 0) {
        this.startedOutbound = true;
        const copyPaths = new Set([...missing.map(({ path }) => path), ...absent.skipped]);
        this.copying = { generation, paths: copyPaths, lower: new Set([...copyPaths].map((path) => path.toLowerCase())) };
        let copied: Awaited<ReturnType<StayPorts["copyIn"]>>;
        try {
          copied = await this.ports.copyIn(missing, () => this.current(generation), absent.skipped);
        } finally {
          if (this.copying?.generation === generation) this.copying = null;
          await this.copyOutbound;
        }
        if (!this.current(generation)) return;
        for (const { path } of missing) {
          if (this.ports.vault.exists(path)) continue;
          delete data.seen[path];
          this.ownBlobs.clear(path);
        }
        this.state.save();
        if (copied.created > 0) return this.ports.lookAgain();
      }
    }
    if (!this.gitChecked) {
      if (this.ports.git) {
        const checked = await this.ports.git.checkSince(data.gitMark).catch(() => null);
        if (!this.current(generation)) return;
        this.observeGit(checked, true);
      }
      this.gitChecked = true;
    }
    const taken = looked.deleted.filter((gone) => this.activity.isGit(gone.path));
    if (taken.length > 0) {
      for (const gone of taken) {
        this.ports.forgetDelete(gone.path);
        this.activity.settled(gone.path);
      }
      this.ports.notify(SAID.taken(taken.length));
      return this.ports.lookAgain();
    }
    this.inbound ??= new Inbound({ ports: this.ports, state: this.state, activity: this.activity, holds: this.holds, isRemoteRoom: (path, sha) => this.roomWrites.matches(path, sha), isOwnBlob: (path, sha) => this.ownBlobs.matches(path, sha), onSettled: (path, sha) => this.ownBlobs.settled(path, sha), onRebasedSent: (path, sha) => this.ownBlobs.noteRebasedSent(path, sha), ...(this.options?.quietWaitMs ? { quietWaitMs: this.options.quietWaitMs } : {}), current: () => this.current(generation), onResolved: (path) => this.conflictResolved(path) });
    const draftIn = this.draftInbound(() => this.current(generation));
    const seenSnapshot = inboundActivePaths(looked, data.seen);
    let changed = 0;
    let rescan = false;
    let unfinished = false;
    let inboundFailed = false;
    let draftBusy: ReadonlySet<string> = new Set();
    const liveHandled = new Set<string>();
    const sentThisPass = new Set<string>();
    let sent = false;
    const shown = !this.ports.hidden();
    try {
      const done = shown ? await this.inbound.run(looked, this.away !== null) : { changed: 0, rescan: false, more: false, wake: null };
      changed = done.changed;
      rescan = done.rescan;
      unfinished = done.more;
      const inboundWake = done.more ? Math.min(MORE_MS, done.wake ?? Number.POSITIVE_INFINITY) : done.wake;
      if (inboundWake !== null && this.current(generation)) this.later("inbound", inboundWake, () => this.ports.lookAgain());
    } catch {
      this.ports.diagnose("a pass of main's changes failed");
      inboundFailed = true;
      unfinished = true;
    }
    if (!this.current(generation)) return;
    if (!inboundFailed && shown && this.heardLater.size > 0) {
      const liveDone = await this.flushHeardDrafts(looked, generation, draftIn, liveHandled);
      changed += liveDone.changed;
      rescan ||= liveDone.rescan;
    }
    if (!this.current(generation)) return;
    if (!inboundFailed && looked.rows.length > 0) {
      const preBusy = new Set([...seenSnapshot, ...liveHandled, ...draftIn.busyBeforeRun(looked, new Set(data.committed))]);
      if (filterRowsForPartial(looked.rows, preBusy).length > 0) {
        sent = (await this.outbound(looked, generation, { busyPaths: preBusy }, sentThisPass)) || sent;
      }
    }
    if (!this.current(generation)) return;
    if (!inboundFailed && shown) {
      try {
        const drafts = await draftIn.run(looked, (sha) => this.inbound?.textOf(sha), new Set([...liveHandled, ...sentThisPass]));
        changed += drafts.changed;
        rescan ||= drafts.rescan;
        draftBusy = drafts.busyPaths;
        this.firstLook.added(drafts.changed);
        if (drafts.more) unfinished = true;
        const draftWake = drafts.more ? Math.min(MORE_MS, drafts.wake ?? Number.POSITIVE_INFINITY) : drafts.wake;
        if (draftWake !== null && this.current(generation)) this.later("drafts", draftWake, () => this.ports.lookAgain());
      } catch {
        this.ports.diagnose("a pass of main's changes failed");
        inboundFailed = true;
        unfinished = true;
      }
      if (this.current(generation) && this.heardLater.size > 0) {
        const afterLive = await this.flushHeardDrafts(looked, generation, draftIn, liveHandled);
        changed += afterLive.changed;
        rescan ||= afterLive.rescan;
      }
    }
    if (!this.current(generation)) return;
    if (this.away) {
      this.away.count += changed;
      if (changed === 0 && !unfinished && !rescan) {
        if (this.away.count > 0) this.ports.notify(DRAFT_SAID.away(this.away.count));
        this.away = null;
      }
    }
    const settlingInbound = changed > 0 || rescan || unfinished;
    if (!settlingInbound) {
      this.firstLook.report(this.ports);
      await this.keepBases(looked, generation);
      if (!this.current(generation)) return;
      sent = (await this.outbound(looked, generation, undefined, sentThisPass)) || sent;
      if (sent && this.current(generation)) this.ports.lookAgain();
      return;
    }
    if (!inboundFailed && this.current(generation)) {
      sent = (await this.outbound(looked, generation, { busyPaths: new Set([...seenSnapshot, ...liveHandled, ...draftBusy]) }, sentThisPass)) || sent;
    }
    if (!this.current(generation)) return;
    if (changed > 0 || rescan || sent) this.ports.lookAgain();
  }

  async bringIn(path: string): Promise<boolean> {
    const looked = this.looked;
    if (!looked || !this.ports.signedIn()) return false;
    const generation = this.generation;
    this.bringer ??= new Inbound({ ports: this.ports, state: this.state, activity: this.activity, holds: this.holds, isRemoteRoom: (path, sha) => this.roomWrites.matches(path, sha), onSettled: (path, sha) => this.ownBlobs.settled(path, sha), ...(this.options?.quietWaitMs ? { quietWaitMs: this.options.quietWaitMs } : {}), current: () => this.generation === generation && this.ports.enabled() });
    return this.bringer.bringIn(looked, path);
  }

  addToMyNote = (path: string, always = false): void => void this.offers.add(path, always);
  addToMyNoteOnce = (path: string): Promise<void> => this.offers.add(path, true);
  offered = (): readonly string[] => this.offers.offered();
  policyFor(path: string, draft: Pick<Draft, "blob">): StayDrafts {
    return this.draftIn?.policyFor(path, draft) ?? this.ports.policy();
  }
  addOffered = (): void => this.offers.addAll();
  livened = (): void => this.offers.livened();

  freed(paths: readonly string[]): void {
    if (paths.length === 0) return;
    for (const path of paths) {
      this.inbound?.release(path);
      this.draftIn?.release(path);
      this.outboundUnsaved.delete(path);
    }
    this.ports.lookAgain();
  }

  private deferOutboundUnsaved(path: string): void {
    const now = this.ports.now();
    const until = stepBackoff(this.outboundUnsaved, path, now, UNSAVED_WAITS_MS);
    if (until !== null) this.sooner("drafts", until - now + WAKE_PAD_MS, () => this.ports.lookAgain());
  }

  panesChanged(onlyPath?: string): void {
    if (!this.on) return;
    const all = [...new Set([...(this.draftIn?.unsavedPaths() ?? []), ...(this.inbound?.unsavedPaths() ?? []), ...this.outboundUnsaved.keys()])];
    const paths = onlyPath === undefined ? all : all.filter((path) => path === onlyPath);
    if (paths.length === 0) return;
    const generation = this.generation;
    void Promise.all(paths.map(async (path) => ((await this.ports.vault.hasUnsavedText(path)) ? null : path))).then((checked) => {
      if (!this.current(generation)) return;
      const free = checked.filter((path): path is string => path !== null);
      if (free.length > 0) this.freed(free);
    });
  }

  private later(timer: Timer, ms: number, fn: () => void): void {
    this.cancelTimer(timer);
    const at = this.ports.now() + ms;
    this.timers.set(timer, {
      at,
      cancel: this.ports.later(() => {
        this.timers.delete(timer);
        fn();
      }, ms),
    });
  }

  private sooner(timer: Timer, ms: number, fn: () => void): void {
    const now = this.ports.now();
    const existing = this.timers.get(timer);
    if (existing && existing.at > now && existing.at <= now + ms) return;
    this.later(timer, ms, fn);
  }

  private cancelTimer(timer: Timer): void {
    this.timers.get(timer)?.cancel();
    this.timers.delete(timer);
  }

  private keepBases(looked: Looked, generation: number): Promise<void> {
    return keepMissingBases(looked, this.ports, this.basesTried, () => this.current(generation));
  }

  private burstFiles(looked: Looked): Looked["rows"] {
    const burst = new Set(this.state.data.burst);
    return looked.rows.filter((row) => row.change.kind === "new" && burst.has(changeKey(row.change)) && !this.ports.inGroup(row.change.path));
  }

  canGroupHeld(): boolean {
    const looked = this.looked;
    return this.on && looked !== null && !this.grouping && this.ports.groupsOn() && !this.ports.groupsLocked() && this.burstFiles(looked).length >= 2;
  }

  async groupHeld(): Promise<{ grouped: number; left: number }> {
    const looked = this.looked;
    if (!this.on || !looked || this.grouping || this.ports.personBusy()) return { grouped: 0, left: 0 };
    this.grouping = true;
    try {
      return await this.groupFiles(looked);
    } finally {
      this.grouping = false;
    }
  }

  private groupFiles(looked: Looked): Promise<{ grouped: number; left: number }> {
    return groupBurstFiles(looked, this.burstFiles(looked), this.ports, this.budget, this.state, () => this.on);
  }

  private pruneHeld(looked: Looked, committed: ReadonlySet<string>): { changed: boolean; releasedFlurry: Set<string> } {
    return this.holds.prune(looked, committed, (key) => {
      this.tries.delete(key);
      this.retryAt.delete(key);
      this.laterTries.delete(key);
    });
  }

  attachmentProblems(path: string, problems: ReadonlyArray<AttachmentProblem>): void {
    this.attachments.problems(path, problems);
  }

  attachmentRow(path: string, words: string | null): void {
    this.attachments.row(path, words);
  }

  heldWhy(path: string): string | null {
    return this.holds.why(this.looked, path, this.on, this.attachments.note(path));
  }

  private conflictKey(looked: Looked, path: string): string {
    const entry = looked.files.get(path);
    return `${looked.drafts?.byPath.get(path)?.blob ?? ""}|${entry?.sha ?? ""}|${entry?.sent ?? ""}|${entry?.base ?? ""}`;
  }

  private draftConflictResolved(path: string): void {
    this.conflicts.delete(path);
    this.githubHeldBase.delete(path);
    this.draftIn?.clearConflict(path);
    if (this.state.data.heldWhy?.[path] === "github") this.holds.clearEditHold(path);
  }

  conflictResolved(path: string): void {
    this.draftConflictResolved(path);
    this.inbound?.caughtUp(path, undefined, false);
    this.ports.choice?.(path, null);
  }

  private followed(looked: Looked, row: Looked["rows"][number], committed: ReadonlySet<string>, blockedNew: BlockedNew): boolean {
    const path = row.change.path;
    const draft = looked.drafts?.byPath.get(path);
    if (isEdit(row, committed, { looked, login: this.ports.login(), blockedNew }) && this.ports.inGroup(path)) {
      if (draft?.inGroup !== true) return false;
      return follows(draft, this.ports.login(), looked.files.get(path), this.policyFor(path, draft));
    }
    if (!draft) return true;
    return follows(draft, this.ports.login(), looked.files.get(path), this.policyFor(path, draft));
  }

  private editRules(looked: Looked): NonNullable<Parameters<typeof planOutbound>[0]["edits"]> | null {
    return buildEditRules({
      looked,
      data: this.state.data,
      login: this.ports.login(),
      quitGraceMs: QUIT_GRACE_MS,
      beganAt: this.beganAt,
      isSuspect: (path) => this.activity.isSuspect(path),
      isRemoteRoom: (path, sha) => this.roomWrites.matches(path, sha),
      isDraftPending: (path) => this.draftIn?.pending(path) === true,
      conflicts: this.conflicts,
      conflictKey: (cur, path) => this.conflictKey(cur, path),
      waitFor: (path, mtime, sentAt) => this.pace.waitFor(path, mtime, sentAt),
      changedByPersonSince: (path, since, mtime, typedAt, sha) => this.activity.changedByPersonSince(path, since, mtime, typedAt, sha),
    });
  }

  private scheduleFlurry(generation: number): void {
    const nextFlurry = this.holds.nextFlurryAt();
    if (nextFlurry !== null && this.current(generation)) this.later("flurry", Math.max(0, nextFlurry - this.ports.now()) + WAKE_PAD_MS, () => this.ports.lookAgain());
    else this.cancelTimer("flurry");
  }

  private ensureFlurryScheduled(generation: number): void {
    const next = this.holds.nextFlurryAt();
    if (next !== null && this.current(generation)) this.sooner("flurry", Math.max(MORE_MS, next - this.ports.now() + WAKE_PAD_MS), () => this.ports.lookAgain());
  }

  private async outbound(looked: Looked, generation: number, partial?: { busyPaths: ReadonlySet<string> }, sentPaths?: Set<string>): Promise<boolean> {
    const { data } = this.state;
    const login = this.ports.login();
    if (!partial) pruneStayLists(looked, data, login);
    const prepared = this.holds.batch(() => {
      if (!partial) {
        refreshGithubHolds(looked, data, this.githubHeldBase, (path, base) => {
          this.conflictResolved(path);
          this.inbound?.caughtUp(path, base);
        });
        const pruned = this.pruneHeld(looked, new Set(data.committed));
        if (!this.startedOutbound || !this.startedEdits) for (const path of pruned.releasedFlurry) this.releasedAtStart.add(path);
        if (syncKeptPaths(looked, data)) {
          this.holds.noteChanged();
          this.ports.lookAgain();
        }
      }
      const edits = this.editRules(looked);
      const quiet = this.activity.quietIn();
      if (quiet > 0 && !partial && !this.startedOutbound) {
        this.scheduleFlurry(generation);
        this.state.save();
        this.later("outbound", quiet + WAKE_PAD_MS, () => this.wakeOutbound(generation));
        return null;
      }
      const atStart = !this.startedOutbound;
      const editsAtStart = edits !== null && !this.startedEdits;
      if (!partial) {
        this.startedOutbound = true;
        if (edits) this.startedEdits = true;
      }
      const startHold: "baseline" | "closed" | null = this.gitMovedAtStart ? "closed" : data.baselinePending === true ? "baseline" : null;
      const committed = new Set(data.committed);
      const blockedNew: BlockedNew = { baseline: new Set(data.baseline), held: new Set(data.held), kept: partial ? keptPathsReadOnly(looked, data) : new Set(data.kept) };
      const baseRows = sentPaths && sentPaths.size > 0 ? looked.rows.filter((row) => !sentPaths.has(row.change.path)) : looked.rows;
      const rows = partial ? filterRowsForPartial(baseRows, partial.busyPaths) : baseRows;
      const plan = planOutbound({
        atStart: startHold === "closed" && atStart,
        editsAtStart: startHold !== null && editsAtStart,
        rows,
        looked,
        login,
        baseline: blockedNew.baseline,
        committed,
        held: blockedNew.held,
        kept: blockedNew.kept,
        ...(this.releasedAtStart.size > 0 ? { released: new Set(this.releasedAtStart) } : {}),
        suspect: (path) => this.activity.isSuspect(path),
        allowed: (row) => {
          const entry = looked.files.get(row.change.path);
          return (
            this.ports.phaseOf(row.change.path) === "local" &&
            !this.ports.disconnected(row.doc) &&
            !isBlankLocalUntitled(row.change.path, entry) &&
            !(isFreshLocalUntitled(row.change.path, entry) && looked.drafts?.byPath.has(row.change.path) === true) &&
            !this.roomWrites.matches(row.change.path, entry?.sha) &&
            !this.draftIn?.holdingRenameSource(row.change.path) &&
            (row.change.from === undefined || !this.draftIn?.holdingRenameSource(row.change.from)) &&
            (this.retryAt.get(changeKey(row.change)) ?? 0) <= this.ports.now() &&
            this.followed(looked, row, committed, blockedNew)
          );
        },
        newWait: (row) => this.activity.quietInFor(row.change.path, row.change.from),
        ...(edits ? { edits } : {}),
      });
      if (!partial) {
        const recorded = this.holds.recordHeld(looked, plan.hold, { startReason: startHold ?? "closed", burst: plan.burst !== null });
        if (this.startedOutbound && this.startedEdits && edits !== null && quiet === 0 && !this.activity.hasGit()) {
          this.releasedAtStart.clear();
          this.gitMovedAtStart = false;
          if (data.baselinePending) delete data.baselinePending;
          if (this.pendingGitMark !== null) {
            data.gitMark = this.pendingGitMark;
            this.pendingGitMark = null;
          }
        }
        if (recorded.pendingDraft) this.ports.lookAgain();
        if (recorded.closedEdits > 0) this.ports.notify(SAID.editsClosed(recorded.closedEdits), { label: "Show them", run: () => this.ports.openStatus?.() }, { lasting: true });
        if (recorded.atStartNew > 0) this.ports.notify(SAID.atStart(recorded.atStartNew));
        if (recorded.arrived > 0) {
          const words = plan.burst === null ? SAID.flurry(recorded.arrived) : SAID.burst(plan.burst);
          const groupable = this.burstFiles(looked).length;
          const action = groupable >= 2 && this.ports.groupsOn() && !this.ports.groupsLocked() ? { label: "Group together", run: () => void this.groupHeld() } : undefined;
          this.ports.notify(words, action, plan.burst !== null ? { lasting: true } : undefined);
        }
        this.scheduleFlurry(generation);
      } else this.ensureFlurryScheduled(generation);
      const needCalm = !partial && quiet > 0 && (data.baselinePending === true || this.pendingGitMark !== null || this.releasedAtStart.size > 0 || this.gitMovedAtStart);
      const wait = Math.min(plan.wait ?? Number.POSITIVE_INFINITY, needCalm ? quiet : Number.POSITIVE_INFINITY);
      if (wait !== Number.POSITIVE_INFINITY && this.current(generation)) this.later("edits", wait + WAKE_PAD_MS, () => this.wakeOutbound(generation));
      this.state.save();
      return { plan, committed, blockedNew };
    });
    if (prepared === null) return false;
    const { plan, committed, blockedNew } = prepared;
    if (!partial) {
      const rowPaths = new Set(looked.rows.map((row) => row.change.path));
      for (const path of [...this.outboundUnsaved.keys()]) if (!rowPaths.has(path)) this.outboundUnsaved.delete(path);
    }
    const { sent, gaveUp, unsure } = await sendPlannedOutbound({
      rows: plan.send,
      looked,
      generation,
      login,
      committed,
      blockedNew,
      writesPerFile: WRITES_PER_FILE,
      maxTries: TRIES,
      ports: this.ports,
      state: this.state,
      activity: this.activity,
      budget: this.budget,
      pace: this.pace,
      holds: this.holds,
      githubHeldBase: this.githubHeldBase,
      conflicts: this.conflicts,
      retryAt: this.retryAt,
      tries: this.tries,
      laterTries: this.laterTries,
      outboundUnsaved: this.outboundUnsaved,
      ...(sentPaths ? { sentPaths } : {}),
      onSent: (path) => void this.sentRecently.set(path, this.ports.now()),
      isCurrent: () => this.current(generation),
      isDraftPending: (path) => this.draftIn?.pending(path) === true,
      memberBranchOf: (path) => (this.looked?.drafts?.byPath.get(path)?.inGroup ? this.looked.drafts.byPath.get(path)!.branch : undefined),
      clearDraftConflict: (path) => void this.draftIn?.clearConflict(path),
      tellDraftConflict: (path, blob) => void this.draftIn?.tellConflict(path, blob),
      conflictKey: (cur, path) => this.conflictKey(cur, path),
      deferOutboundUnsaved: (path) => this.deferOutboundUnsaved(path),
      deletedOnGithub: (path, at) => this.deletedOnGithub(path, at),
      scheduleOutbound: (ms) => this.later("outbound", ms, () => this.wakeOutbound(generation)),
    });
    if (!this.current(generation)) return false;
    if (unsure > 0) this.ports.notify(`${LOST_ANSWER_TITLE}. ${LOST_ANSWER_DESCRIPTION}`);
    const next = Math.min(...[...this.retryAt.values()].filter((at) => at > this.ports.now()), Number.POSITIVE_INFINITY);
    if (next !== Number.POSITIVE_INFINITY) this.later("outbound", next - this.ports.now() + WAKE_PAD_MS, () => this.wakeOutbound(generation));
    if (gaveUp > 0) this.ports.notify(SAID.gaveUp(gaveUp));
    if (sent > 0 && !partial) this.ports.lookAgain();
    return sent > 0;
  }
}
