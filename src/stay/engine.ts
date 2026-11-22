import type { DocumentRef } from "../mapping";
import type { Looked } from "../changes/model";
import { GROUP_NOT_ON_WORDS, GROUP_PLAN_WORDS, LOST_ANSWER_DESCRIPTION, LOST_ANSWER_TITLE } from "../shared/review-flow";
import { toLf } from "../disk/line-endings";
import { agreedOf } from "../changes/cache";
import { Activity } from "./activity";
import { DraftOffers, FirstLook } from "./aware-steps";
import { DraftInbound } from "./draft-inbound";
import { follows } from "./draft-state";
import { ATTACHMENT_HELD, ATTACHMENT_LATER } from "../changes/attachment-memory";
import { DRAFT_SAID, ATTACHMENTS_SAID } from "./words";
import { gitBlobShaOfText } from "../changes/blob-sha";
import { StayHolds } from "./holds";
import { Inbound } from "./inbound";
import { missingNotes } from "../changes/missing-notes";
import { groupWrites, WRITES_PER_FILE } from "../changes/burst";
import { Pace, WriteBudget } from "./limits";
import { changeKey, isEdit, planOutbound } from "./outbound";
import { ATTACHMENTS_KEPT, ATTACHMENTS_PER_NOTE, type StayState, TYPED_KEPT } from "./state";
import type { StayPorts } from "./types";
import { WAKE_PAD_MS } from "./wait";

export const HEARD_MS = 1_500;
export const ENDED_WATCH_MS = 65_000;
const MORE_MS = 2_000;
const BASES_PER_PASS = 10;
const BASES_BATCHED_PER_PASS = 50;
const RETRY_MS = 60_000;
const TRIES = 3;
const ATTACHMENT_BACKOFF_MS = [30_000, 120_000, 600_000];

const manyAtOnce = (count: number): string =>
  count === 1 ? "1 file changed along with many others at once, so it wasn't saved. It's in the Status tab." : `${count} files changed at once, so they weren't saved one by one. They're in the Status tab.`;

const SAID = {
  burst: (count: number) => manyAtOnce(count),
  flurry: (count: number) => manyAtOnce(count),
  atStart: (count: number) => `${count} new or renamed ${count === 1 ? "file was" : "files were"} here when Obsidian opened. ${count === 1 ? "It's" : "They're"} in the Status tab.`,
  taken: (count: number) => `${count === 1 ? "A note was" : `${count} notes were`} removed by another app or a sync. Nothing is deleted from GitHub.`,
  editsClosed: (count: number) => `${count === 1 ? "1 note" : `${count} notes`} changed while Obsidian was closed. ${count === 1 ? "It's" : "They're"} in the Status tab, not saved yet.`,
  gaveUp: (count: number) => `specgit couldn't save ${count === 1 ? "a file" : `${count} files`} automatically. ${count === 1 ? "It's" : "They're"} in the Status tab.`,
};

const QUIT_GRACE_MS = 5_000;

const SAVE_SOON_MS = 5_000;

type Timer = "inbound" | "outbound" | "edits" | "drafts" | "flurry";

export class StayConnected {
  private on = false;
  private generation = 0;
  private looked: Looked | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private inbound: Inbound | null = null;
  private bringer: Inbound | null = null;
  private draftIn: DraftInbound | null = null;
  private readonly pace: Pace;
  private readonly holds: StayHolds;
  private readonly conflicts = new Map<string, string>();
  private readonly timers = new Map<Timer, { cancel: () => void; at: number }>();
  private readonly heard = new Map<string, () => void>();
  private readonly heardLater = new Set<string>();
  private saving: (() => void) | null = null;
  private readonly attachmentNotes = new Map<string, string>();
  private readonly attachmentTimers = new Map<string, () => void>();
  private readonly attachmentTries = new Map<string, number>();
  private readonly attachmentLeft = new Map<string, ReadonlyArray<{ name: string; why: string; server?: true }>>();
  private readonly attachmentRetrying = new Set<string>();
  private readonly attachmentQueue: string[] = [];
  private attachmentWake: (() => void) | null = null;
  private attachmentRunning = false;
  private readonly attachmentReported = new Set<string>();
  private readonly heardShas = new Map<string, { waiting: Set<string>; read: string[] }>();
  private readonly endWatch = new Map<string, () => void>();
  private away: { count: number } | null = null;
  private readonly retryAt = new Map<string, number>();
  private readonly tries = new Map<string, number>();
  private readonly basesTried = new Set<string>();
  private readonly releasedAtStart = new Set<string>();
  private startedOutbound = false;
  private startedEdits = false;
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
    return (this.draftIn ??= new DraftInbound({ ports: this.ports, state: this.state, activity: this.activity, holds: this.holds, current }));
  }

  constructor(
    private readonly ports: StayPorts,
    private readonly state: StayState,
    readonly activity: Activity,
    private readonly budget: WriteBudget,
  ) {
    this.pace = new Pace(budget, () => ports.now());
    this.holds = new StayHolds(state, activity, ports);
  }

  isOn(): boolean {
    return this.on;
  }

  enable(): void {
    if (this.on) return;
    this.on = true;
    this.beganAt = this.ports.now();
    this.generation++;
    this.activity.listener = (path) => this.typing(path);
    this.restoreAttachments();
    this.ports.lookAgain();
  }

  private typing(path: string): void {
    if (!this.on || this.activity.isSuspect(path)) return;
    const generation = this.generation;
    const typed = (this.state.data.typed ??= {});
    const at = this.ports.now();
    typed[path] = { sha: "", at };
    const keys = Object.keys(typed);
    if (keys.length > TYPED_KEPT) for (const old of keys.sort((a, b) => typed[a]!.at - typed[b]!.at).slice(0, keys.length - TYPED_KEPT)) delete typed[old];
    this.saveSoon();
    void this.ports.vault.read(path).then((text) => {
      if (text === null || !this.current(generation)) return;
      const mark = this.state.data.typed?.[path];
      if (mark === undefined || mark.at !== at) return;
      mark.sha = gitBlobShaOfText(text);
      this.saveSoon();
    });
  }

  flush(): void {
    if (!this.on || this.saving === null) return;
    this.saving();
    this.saving = null;
    this.state.save();
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
    this.activity.listener = null;
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
    for (const cancel of this.heard.values()) cancel();
    this.heard.clear();
    for (const cancel of this.endWatch.values()) cancel();
    this.endWatch.clear();
    this.heardLater.clear();
    this.heardShas.clear();
    this.attachmentNotes.clear();
    for (const cancel of this.attachmentTimers.values()) cancel();
    this.attachmentTimers.clear();
    this.attachmentTries.clear();
    this.attachmentQueue.length = 0;
    this.attachmentWake?.();
    this.attachmentWake = null;
    this.attachmentLeft.clear();
    this.attachmentRetrying.clear();
    this.attachmentReported.clear();
    this.away = null;
    this.looked = null;
    this.retryAt.clear();
    this.tries.clear();
    this.basesTried.clear();
    this.releasedAtStart.clear();
    this.startedOutbound = false;
    this.startedEdits = false;
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
    if (this.running) {
      this.again = true;
      return;
    }
    this.track(this.pass());
  }

  private track(work: Promise<void>): void {
    this.running = work.finally(() => {
      this.running = null;
      const generation = this.generation;
      for (const path of [...this.heardLater]) {
        this.heardLater.delete(path);
        this.heardDraft(path, 0, generation);
      }
      if (this.again) {
        this.again = false;
        if (this.looked) this.lookedAt(this.looked);
      }
    });
  }

  async holdStopped(path: string): Promise<void> {
    if (!this.on) return;
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
          if (done.changed > 0) this.ports.lookAgain();
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
    const known = looked.drafts?.byPath.has(path) === true || looked.files.get(path)?.sent !== undefined;
    if (!known) return this.ports.lookAgain();
    const draftIn = this.draftInbound(() => this.current(generation));
    this.track(
      (async () => {
        try {
          const done = await draftIn.readOne(looked, path);
          if (!this.current(generation)) return;
          const shas = this.heardShas.get(path);
          if (shas) {
            shas.read = [...shas.read, ...shas.waiting].slice(-8);
            shas.waiting.clear();
          }
          if (done.wake !== null) this.sooner("drafts", done.wake, () => this.ports.lookAgain());
          if (done.changed > 0) this.ports.lookAgain();
        } catch {
          this.ports.diagnose("a draft that the events named could not be read");
        }
      })(),
    );
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private current(generation: number): boolean {
    return this.on && this.generation === generation && this.ports.enabled();
  }

  private async pass(): Promise<void> {
    const generation = this.generation;
    const looked = this.looked;
    if (!looked || !this.ports.signedIn() || this.ports.personBusy()) return;
    const { data } = this.state;
    if (data.seen === null || data.baseline === null) {
      data.seen = Object.fromEntries([...looked.repo].map(([path, sha]) => [path, looked.files.get(path)?.base ?? sha]));
      data.guessed = [...looked.repo.keys()].filter((path) => (looked.files.get(path)?.base ?? null) === null);
      data.baseline = looked.rows.map((row) => changeKey(row.change));
      this.state.save();
      this.firstLook.begin();
      const absent = missingNotes(looked.repo.keys(), looked.files.keys(), looked.deleted.map((gone) => gone.path));
      const missing = absent.copy.flatMap((path) => {
        const doc = this.ports.documentFor(path);
        return doc ? [{ path, doc }] : [];
      });
      if (missing.length > 0) {
        this.startedOutbound = true;
        const copied = await this.ports.copyIn(missing, () => this.current(generation), absent.skipped);
        if (!this.current(generation)) return;
        for (const { path } of missing) if (!this.ports.vault.exists(path)) delete data.seen[path];
        this.state.save();
        if (copied.created > 0) return this.ports.lookAgain();
      }
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
    this.inbound ??= new Inbound({ ports: this.ports, state: this.state, activity: this.activity, holds: this.holds, current: () => this.current(generation) });
    const draftIn = this.draftInbound(() => this.current(generation));
    let changed = 0;
    let unfinished = false;
    try {
      const shown = !this.ports.hidden();
      const done = shown ? await this.inbound.run(looked, this.away !== null) : { changed: 0, more: false, wake: null };
      changed = done.changed;
      unfinished = done.more;
      const inboundWake = done.more ? Math.min(MORE_MS, done.wake ?? Number.POSITIVE_INFINITY) : done.wake;
      if (inboundWake !== null && this.current(generation)) this.later("inbound", inboundWake, () => this.ports.lookAgain());
      if (this.current(generation) && shown) {
        const drafts = await draftIn.run(looked, (sha) => this.inbound?.textOf(sha));
        changed += drafts.changed;
        this.firstLook.added(drafts.changed);
        if (drafts.more) unfinished = true;
        const draftWake = drafts.more ? Math.min(MORE_MS, drafts.wake ?? Number.POSITIVE_INFINITY) : drafts.wake;
        if (draftWake !== null && this.current(generation)) this.later("drafts", draftWake, () => this.ports.lookAgain());
      }
    } catch {
      this.ports.diagnose("a pass of main's changes failed");
      unfinished = true;
    }
    if (!this.current(generation)) return;
    if (this.away) {
      this.away.count += changed;
      if (changed === 0 && !unfinished) {
        if (this.away.count > 0) this.ports.notify(DRAFT_SAID.away(this.away.count));
        this.away = null;
      }
    }
    if (changed > 0) return this.ports.lookAgain();
    if (unfinished) return;
    this.firstLook.report(this.ports);
    await this.keepBases(looked, generation);
    if (!this.current(generation)) return;
    await this.outbound(looked, generation);
  }

  async bringIn(path: string): Promise<boolean> {
    const looked = this.looked;
    if (!looked || !this.ports.signedIn()) return false;
    const generation = this.generation;
    this.bringer ??= new Inbound({ ports: this.ports, state: this.state, activity: this.activity, holds: this.holds, current: () => this.generation === generation && this.ports.enabled() });
    return this.bringer.bringIn(looked, path);
  }

  addToMyNote = (path: string, always = false): void => this.offers.add(path, always);
  offered = (): readonly string[] => this.offers.offered();
  addOffered = (): void => this.offers.addAll();
  livened = (): void => this.offers.livened();

  freed(paths: readonly string[]): void {
    if (paths.length === 0) return;
    for (const path of paths) {
      this.inbound?.release(path);
      this.draftIn?.release(path);
    }
    this.ports.lookAgain();
  }

  panesChanged(): void {
    if (!this.on) return;
    const paths = [...new Set([...(this.draftIn?.unsavedPaths() ?? []), ...(this.inbound?.unsavedPaths() ?? [])])];
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

  private async keepBases(looked: Looked, generation: number): Promise<void> {
    const wanted: Array<{ change: Looked["rows"][number]["change"]; doc: DocumentRef }> = [];
    for (const { change, doc } of looked.rows) {
      if (change.kind !== "edited" || change.base === null || change.repoSha !== change.base) continue;
      if (this.ports.baseText(change.path, change.base) !== null || this.ports.phaseOf(change.path) !== "local" || this.basesTried.has(`${change.path}|${change.base}`)) continue;
      this.basesTried.add(`${change.path}|${change.base}`);
      wanted.push({ change, doc });
    }
    const together = this.ports.blobTexts ? await this.ports.blobTexts(wanted.slice(0, BASES_BATCHED_PER_PASS).map(({ change, doc }) => ({ doc, sha: change.base! }))) : new Map<string, string>();
    if (!this.current(generation)) return;
    let reads = 0;
    for (const [at, { change, doc }] of wanted.entries()) {
      const text = at < BASES_BATCHED_PER_PASS ? together.get(change.base!) : undefined;
      if (text !== undefined) {
        this.ports.recordBase(change.path, doc, toLf(text), text);
        continue;
      }
      if (reads++ >= BASES_PER_PASS || !this.current(generation)) return;
      const main = await this.ports.gitFile(doc);
      if (main.kind === "file" && main.sha === change.base && this.current(generation)) this.ports.recordBase(change.path, doc, toLf(main.text), main.text);
    }
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

  private async groupFiles(looked: Looked): Promise<{ grouped: number; left: number }> {
    if (!this.ports.groupsOn()) {
      this.ports.notify(GROUP_NOT_ON_WORDS);
      return { grouped: 0, left: 0 };
    }
    if (this.ports.groupsLocked()) {
      this.ports.notify(GROUP_PLAN_WORDS);
      return { grouped: 0, left: 0 };
    }
    const files = this.burstFiles(looked);
    if (files.length < 2) {
      this.ports.notify(files.length === 1 ? "A group needs two or more files, so this one stays in the Status tab." : "Nothing is waiting to be grouped.");
      return { grouped: 0, left: files.length };
    }
    const cost = groupWrites(files.length, files.reduce((sum, row) => sum + (looked.files.get(row.change.path)?.size ?? 0), 0));
    const blocked = this.budget.waitFor(cost);
    if (blocked > 0) {
      this.ports.notify(`GitHub asked specgit to slow down. Try again in ${Math.ceil(blocked / 60_000)} min.`);
      return { grouped: 0, left: files.length };
    }
    const made = await this.ports.createGroup([...files]);
    if (made.writes > 0) this.budget.spend(made.writes);
    if (made.outcome === "limited") {
      this.budget.limited(made.retryAfterMs);
    }
    this.state.save();
    if (made.outcome !== "made" || !this.on) return { grouped: 0, left: files.length };
    this.ports.lookAgain();
    return { grouped: files.length, left: 0 };
  }

  private pruneHeld(looked: Looked, committed: ReadonlySet<string>): { changed: boolean; releasedFlurry: Set<string> } {
    return this.holds.prune(looked, committed, (key) => {
      this.tries.delete(key);
      this.retryAt.delete(key);
    });
  }

  attachmentProblems(path: string, problems: ReadonlyArray<{ name: string; why: string; server?: true }>): void {
    this.attachmentReported.add(path);
    this.attachmentTimers.get(path)?.();
    this.attachmentTimers.delete(path);
    if (!this.attachmentRetrying.has(path)) this.attachmentTries.delete(path);
    if (problems.length === 0) {
      const had = this.attachmentNotes.delete(path);
      this.attachmentTries.delete(path);
      this.attachmentLeft.delete(path);
      this.keepAttachments(path);
      if (had) this.ports.holdsChanged?.();
      return;
    }
    this.attachmentLeft.set(path, problems);
    this.keepAttachments(path);
    const later = problems.some((one) => one.why === ATTACHMENT_LATER);
    const tried = this.attachmentTries.get(path) ?? 0;
    if (later && tried >= ATTACHMENT_BACKOFF_MS.length) {
      this.attachmentNotes.set(path, ATTACHMENTS_SAID(problems.map((one) => (one.why === ATTACHMENT_LATER ? { ...one, why: ATTACHMENT_HELD } : one))));
      this.ports.holdsChanged?.();
      return;
    }
    this.attachmentNotes.set(path, ATTACHMENTS_SAID(problems));
    this.ports.holdsChanged?.();
    if (later && this.on) this.attachmentTimers.set(path, this.ports.later(() => this.retryAttachments(path, this.generation), ATTACHMENT_BACKOFF_MS[tried]!));
  }

  private keepAttachments(path: string): void {
    const { data } = this.state;
    const problems = this.attachmentLeft.get(path);
    if (problems === undefined) {
      if (data.attachments?.[path] === undefined) return;
      delete data.attachments[path];
    } else {
      const kept = (data.attachments ??= {});
      delete kept[path];
      kept[path] = { problems: problems.slice(0, ATTACHMENTS_PER_NOTE).map((one) => ({ name: one.name, why: one.why, ...(one.server ? { server: true as const } : {}) })), tries: this.attachmentTries.get(path) ?? 0 };
      const paths = Object.keys(kept);
      for (const old of paths.slice(0, Math.max(0, paths.length - ATTACHMENTS_KEPT))) delete kept[old];
    }
    this.saveSoon();
  }

  private restoreAttachments(): void {
    for (const [path, kept] of Object.entries(this.state.data.attachments ?? {})) {
      this.attachmentTries.set(path, kept.tries);
      this.attachmentRetrying.add(path);
      this.attachmentProblems(path, kept.problems.map((one) => ({ ...one })));
      this.attachmentRetrying.delete(path);
    }
  }

  private retryAttachments(path: string, generation: number): void {
    this.attachmentTimers.delete(path);
    if (!this.on || !this.current(generation) || this.ports.retryAttachments === undefined) return;
    if (!this.attachmentQueue.includes(path)) this.attachmentQueue.push(path);
    void this.drainAttachments(generation);
  }

  private wakeAttachments(ms: number, generation: number): void {
    this.attachmentWake?.();
    this.attachmentWake = this.ports.later(() => {
      this.attachmentWake = null;
      void this.drainAttachments(generation);
    }, ms);
  }

  private async drainAttachments(generation: number): Promise<void> {
    if (this.attachmentRunning || this.ports.retryAttachments === undefined) return;
    this.attachmentRunning = true;
    try {
      while (this.attachmentQueue.length > 0 && this.on && this.current(generation)) {
        const path = this.attachmentQueue[0]!;
        const row = this.looked?.rows.find((one) => one.change.path === path);
        if (row === undefined) {
          this.attachmentQueue.shift();
          this.attachmentProblems(path, []);
          continue;
        }
        if (this.ports.hidden() || this.ports.personBusy() || this.ports.offline()) {
          this.wakeAttachments(ATTACHMENT_BACKOFF_MS[0]!, generation);
          return;
        }
        const wait = this.budget.waitFor(WRITES_PER_FILE);
        if (wait > 0) {
          this.wakeAttachments(wait, generation);
          return;
        }
        this.attachmentQueue.shift();
        this.attachmentTries.set(path, (this.attachmentTries.get(path) ?? 0) + 1);
        this.keepAttachments(path);
        this.attachmentRetrying.add(path);
        this.attachmentReported.delete(path);
        const hooks = { edit: true as const, notWritten: (one: string) => this.activity.notWritten(one), during: <T,>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null) => this.activity.during(paths, run, left) };
        const sent = await this.ports.retryAttachments(row, () => this.current(generation), hooks).catch(() => ({ result: "later" as const, writes: 0 }));
        if (!this.current(generation)) return;
        if (sent.writes > 0) this.budget.spend(sent.writes);
        if (sent.result === "done" && sent.writes > 0) this.budget.succeeded();
        this.retried(path, generation, sent.result);
        if (sent.result === "limited") {
          this.budget.limited(sent.retryAfterMs);
          this.wakeAttachments(Math.max(0, this.budget.backoff().until - this.ports.now()), generation);
          return;
        }
      }
    } finally {
      this.attachmentRunning = false;
    }
  }

  private retried(path: string, generation: number, result: "done" | "later" | "limited"): void {
    this.attachmentRetrying.delete(path);
    if (!this.current(generation)) return;
    if (result === "done" && !this.attachmentReported.has(path)) this.attachmentProblems(path, []);
    else if (result !== "done" && !this.attachmentReported.has(path)) {
      this.attachmentRetrying.add(path);
      this.attachmentProblems(path, this.attachmentLeft.get(path) ?? []);
      this.attachmentRetrying.delete(path);
    }
  }

  attachmentRow(path: string, words: string | null): void {
    const before = this.attachmentNotes.get(path) ?? null;
    if (words === null) this.attachmentNotes.delete(path);
    else this.attachmentNotes.set(path, words);
    if (before !== words) this.ports.holdsChanged?.();
  }

  heldWhy(path: string): string | null {
    return this.holds.why(this.looked, path, this.on, this.attachmentNotes.get(path) ?? null);
  }

  private conflictKey(looked: Looked, path: string): string {
    return `${looked.drafts?.byPath.get(path)?.blob ?? ""}|${looked.files.get(path)?.sha ?? ""}`;
  }

  private followed(looked: Looked, row: Looked["rows"][number], committed: ReadonlySet<string>): boolean {
    const path = row.change.path;
    const draft = looked.drafts?.byPath.get(path);
    if (isEdit(row, committed) && this.ports.inGroup(path)) return draft?.inGroup === true;
    if (!draft) return true;
    return follows(draft, this.ports.login(), looked.files.get(path)?.sentTo, this.draftIn?.policyFor(path, draft) ?? this.ports.policy());
  }

  private editRules(looked: Looked): NonNullable<Parameters<typeof planOutbound>[0]["edits"]> | null {
    if (!looked.drafts) return null;
    const held = this.state.data.editsHeld ?? {};
    return {
      own: (row) => {
        const entry = looked.files.get(row.change.path);
        return entry !== undefined && (agreedOf(entry) === undefined || entry.sha !== agreedOf(entry));
      },
      held: (row) => {
        const path = row.change.path;
        const entry = looked.files.get(path);
        if (entry === undefined || held[path] === entry.sha) return true;
        const conflict = this.conflicts.get(path);
        if (conflict === undefined) return false;
        if (conflict === this.conflictKey(looked, path)) return true;
        this.conflicts.delete(path);
        return false;
      },
      wait: (row) => {
        const entry = looked.files.get(row.change.path);
        return entry === undefined ? 0 : this.pace.waitFor(row.change.path, entry.mtime, entry.sentAt);
      },
      after: (row) => {
        const entry = looked.files.get(row.change.path);
        return entry !== undefined && this.activity.changedByPersonSince(row.change.path, this.beganAt, entry.mtime, this.state.data.typed?.[row.change.path]?.at, entry.sha);
      },
      typed: (row) => {
        const mark = this.state.data.typed?.[row.change.path];
        const entry = looked.files.get(row.change.path);
        if (mark === undefined || entry === undefined) return false;
        return mark.sha === entry.sha || (entry.mtime >= mark.at - QUIT_GRACE_MS && entry.mtime <= mark.at + QUIT_GRACE_MS);
      },
    };
  }

  private scheduleFlurry(generation: number): void {
    const nextFlurry = this.holds.nextFlurryAt();
    if (nextFlurry !== null && this.current(generation)) this.later("flurry", Math.max(0, nextFlurry - this.ports.now()) + WAKE_PAD_MS, () => this.ports.lookAgain());
    else this.cancelTimer("flurry");
  }

  private async outbound(looked: Looked, generation: number): Promise<void> {
    const { data } = this.state;
    const keys = new Set(looked.rows.map((row) => changeKey(row.change)));
    data.baseline = (data.baseline ?? []).filter((key) => keys.has(key));
    data.committed = data.committed.filter((key) => keys.has(key));
    data.held = [...new Set(data.held.filter((key) => keys.has(key)))];
    data.burst = data.burst.filter((key) => keys.has(key));
    const prepared = this.holds.batch(() => {
      const pruned = this.pruneHeld(looked, new Set(data.committed));
      if (!this.startedOutbound || !this.startedEdits) for (const path of pruned.releasedFlurry) this.releasedAtStart.add(path);
      const seen = data.seen ?? {};
      const newPaths = new Set(looked.rows.filter((row) => row.change.kind === "new").map((row) => row.change.path));
      const kept = [...new Set([...data.kept, ...[...newPaths].filter((path) => seen[path] !== undefined)])].filter((path) => newPaths.has(path));
      const grew = kept.some((path) => !data.kept.includes(path));
      data.kept = kept;
      if (grew) {
        this.holds.noteChanged();
        this.ports.lookAgain();
      }
      const edits = this.editRules(looked);
      const quiet = this.activity.quietIn();
      if (quiet > 0 && (!this.startedOutbound || !edits)) {
        this.scheduleFlurry(generation);
        this.state.save();
        this.later("outbound", quiet + WAKE_PAD_MS, () => this.ports.lookAgain());
        return null;
      }
      const atStart = !this.startedOutbound;
      this.startedOutbound = true;
      const editsAtStart = edits !== null && !this.startedEdits;
      if (edits) this.startedEdits = true;
      const committed = new Set(data.committed);
      const plan = planOutbound({
        atStart,
        editsAtStart,
        rows: looked.rows,
        baseline: new Set(data.baseline),
        committed,
        held: new Set(data.held),
        kept: new Set(data.kept),
        ...(this.releasedAtStart.size > 0 ? { released: new Set(this.releasedAtStart) } : {}),
        suspect: (path) => this.activity.isSuspect(path),
        allowed: (row) => this.ports.phaseOf(row.change.path) === "local" && !this.ports.disconnected(row.doc) && (this.retryAt.get(changeKey(row.change)) ?? 0) <= this.ports.now() && this.followed(looked, row, committed),
        settling: quiet > 0,
        ...(edits ? { edits } : {}),
      });
      if (this.startedOutbound && this.startedEdits) this.releasedAtStart.clear();
      const heldNew = plan.hold.filter((held) => held.edit !== true);
      const heldEdits = plan.hold.filter((held) => held.edit === true);
      const flurryUntil = (path: string, isClosed: boolean): number | undefined => (!isClosed && plan.burst === null && !this.activity.isGit(path) ? this.activity.flurryDeadline(path) : undefined);
      for (const held of heldEdits) {
        const isClosed = held.atStart === true;
        const until = flurryUntil(held.path, isClosed);
        this.holds.holdEdit(looked, held.path, isClosed ? "closed" : "flurry", until !== undefined ? { flurryUntil: until } : undefined);
      }
      const closedCount = heldEdits.filter((held) => held.atStart === true).length;
      if (closedCount > 0) this.ports.notify(SAID.editsClosed(closedCount), { label: "Show them", run: () => this.ports.openStatus?.() }, { lasting: true });
      for (const held of heldNew) {
        const isClosed = held.atStart === true;
        const until = flurryUntil(held.path, isClosed);
        this.holds.holdNew(looked, held.key, held.path, isClosed ? "closed" : "flurry", { ...(isClosed ? {} : { burst: true }), ...(until !== undefined ? { flurryUntil: until } : {}) });
      }
      const atStartNew = heldNew.filter((held) => held.atStart === true);
      const arrived = plan.hold.filter((held) => held.atStart !== true);
      if (atStartNew.length) this.ports.notify(SAID.atStart(atStartNew.length));
      if (arrived.length) {
        const words = plan.burst === null ? SAID.flurry(arrived.length) : SAID.burst(plan.burst);
        const groupable = this.burstFiles(looked).length;
        const action = groupable >= 2 && this.ports.groupsOn() && !this.ports.groupsLocked() ? { label: "Group together", run: () => void this.groupHeld() } : undefined;
        this.ports.notify(words, action, plan.burst !== null ? { lasting: true } : undefined);
      }
      for (const { path } of plan.hold) this.activity.settled(path);
      this.scheduleFlurry(generation);
      const waits = [plan.wait ?? Number.POSITIVE_INFINITY, quiet > 0 ? quiet : Number.POSITIVE_INFINITY];
      if (Math.min(...waits) !== Number.POSITIVE_INFINITY && this.current(generation)) this.later("edits", Math.min(...waits) + WAKE_PAD_MS, () => this.ports.lookAgain());
      this.state.save();
      return { plan, committed };
    });
    if (prepared === null) return;
    const { plan, committed } = prepared;
    let sent = 0;
    let gaveUp = 0;
    let unsure = 0;
    for (const row of plan.send) {
      if (!this.current(generation) || this.ports.personBusy()) break;
      const wait = this.budget.waitFor(WRITES_PER_FILE);
      if (wait > 0) {
        this.later("outbound", wait, () => this.ports.lookAgain());
        break;
      }
      const key = changeKey(row.change);
      const edit = isEdit(row, committed);
      const { result, writes, deletedAt, retryAfterMs } = await this.ports.commit(row, () => this.current(generation), edit ? { edit: true as const, ...(this.draftIn?.pending(row.change.path) ? { ended: true as const } : {}), ...(this.looked?.drafts?.byPath.get(row.change.path)?.inGroup ? { memberBranch: this.looked.drafts.byPath.get(row.change.path)!.branch } : {}), notWritten: (path) => this.activity.notWritten(path), during: (paths, run, left) => this.activity.during(paths, run, left) } : undefined);
      if (writes > 0) this.budget.spend(writes);
      if (!this.current(generation)) break;
      if (result === "committed" || result === "held" || result === "conflict") delete this.state.data.typed?.[row.change.path];
      if (result === "committed") {
        this.budget.succeeded();
        if (edit) this.pace.saved(row.change.path);
        else data.committed.push(key);
        sent++;
      } else if (result === "deleted") {
        this.deletedOnGithub(row.change.path, deletedAt ?? this.ports.now());
      } else if (result === "held") {
        if (edit) this.holds.holdEdit(looked, row.change.path, "github");
        else this.holds.holdNew(looked, key, row.change.path, "github");
      } else if (result === "conflict") {
        this.conflicts.set(row.change.path, this.conflictKey(looked, row.change.path));
        this.draftIn?.tellConflict(row.change.path, looked.drafts?.byPath.get(row.change.path)?.blob ?? null);
      } else if (result === "limited") {
        this.budget.limited(retryAfterMs);
        this.later("outbound", Math.max(0, this.budget.backoff().until - this.ports.now()), () => this.ports.lookAgain());
        this.state.save();
        break;
      } else if (result === "unsure" || result === "later") {
        this.retryAt.set(key, this.ports.now() + RETRY_MS);
        if (result === "unsure") unsure++;
      } else {
        const tried = (this.tries.get(key) ?? 0) + 1;
        this.tries.set(key, tried);
        this.retryAt.set(key, this.ports.now() + RETRY_MS * tried);
        if (tried >= TRIES) {
          if (edit) this.holds.holdEdit(looked, row.change.path, "tries");
          else this.holds.holdNew(looked, key, row.change.path, "tries");
          gaveUp++;
        }
      }
      this.state.save();
    }
    if (!this.current(generation)) return;
    if (unsure > 0) this.ports.notify(`${LOST_ANSWER_TITLE}. ${LOST_ANSWER_DESCRIPTION}`);
    const next = Math.min(...[...this.retryAt.values()].filter((at) => at > this.ports.now()), Number.POSITIVE_INFINITY);
    if (next !== Number.POSITIVE_INFINITY) this.later("outbound", next - this.ports.now() + WAKE_PAD_MS, () => this.ports.lookAgain());
    if (gaveUp > 0) this.ports.notify(SAID.gaveUp(gaveUp));
    if (sent > 0) this.ports.lookAgain();
  }
}
