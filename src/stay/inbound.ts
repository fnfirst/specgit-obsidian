import { gitBlobShaOfText } from "../changes/blob-sha";
import { matchedBase } from "../changes/merge-base";
import { unchangedHere } from "../changes/unchanged-here";
import type { Looked } from "../changes/model";
import type { MainFile } from "../auth/git-copy";
import { Budget } from "../disk/diff";
import { follows } from "./draft-state";
import { changesBetween } from "../disk/merge";
import type { Shown } from "../disk/regions";
import { eolOf, toLf, withEol } from "../disk/line-endings";
import { reconcile } from "../disk/reconcile";
import { notWritableBecause } from "../disk/writable";
import type { ReviewRequest } from "../editor/services";
import { type DocumentRef, noteName } from "../mapping";
import type { Activity } from "./activity";
import { BURST_FILES } from "./limits";
import { CHOICE_WORDS, DRAFT_SAID } from "./words";
import type { StayState } from "./state";
import type { StayPorts } from "./types";

export const READS_PER_PASS = 40;

export const trashedWords = (names: readonly string[]): string => `Moved ${names.length === 1 ? names[0]! : `${names.length} notes`} to the trash. ${names.length === 1 ? "It was" : "They were"} deleted on GitHub.`;
export const heldDeletesWords = (count: number): string => `${count} notes were deleted on GitHub at once, so none was moved to the trash.`;
export const TEXTS_PER_PASS = 200;
export const FIRST_WAIT_MS = 20_000;
export const MAX_WAIT_MS = 5 * 60_000;
export const STUCK_MS = 60_000;
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

export interface InboundContext {
  ports: StayPorts;
  state: StayState;
  activity: Activity;
  current(): boolean;
}

type MainText = Extract<MainFile, { kind: "file" }>;

interface Said {
  updated: string[];
  merged: string[];
  created: string[];
  moved: string[];
  trashed: string[];
  came: Array<{ name: string; shown: Shown[] }>;
}

export class Inbound {
  private readonly declined = new Map<string, string>();
  private readonly deciding = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly waiting = new Map<string, { sha: string; until: number; strikes: number }>();
  private readonly announced = new Map<string, string>();
  private readonly cues = new Map<string, { sha: string; since: number; told: boolean }>();
  private readonly opening = new Set<string>();
  private readonly reviewTold = new Map<string, string>();
  private looked: Looked | null = null;
  private texts = new Map<string, string>();
  private gone: Map<string, boolean> | null = null;
  private reads = 0;
  private cut = false;
  private readonly releasedDeletes = new Set<string>();
  private announcedDeletes = 0;
  private readonly pendingRenames = new Map<string, { to: string; sha: string }>();
  private readonly renameTold = new Set<string>();

  constructor(private readonly ctx: InboundContext) {}

  release(path: string): void {
    this.waiting.delete(path);
  }

  stop(): void {
    this.abort.abort();
  }

  async run(looked: Looked, silent = false): Promise<{ changed: number; more: boolean }> {
    const { state } = this.ctx;
    const seen = state.data.seen;
    if (!seen) return { changed: 0, more: false };
    this.reads = 0;
    this.cut = false;
    this.looked = looked;
    const said: Said = { updated: [], merged: [], created: [], moved: [], trashed: [], came: [] };
    const added = [...looked.repo].filter(([path, sha]) => seen[path] !== sha);
    const removed = Object.entries(seen).filter(([path]) => !looked.repo.has(path));
    const moves = this.pairMoves(looked, added, removed);
    const inMove = new Set(moves.flatMap((move) => [move.from, move.to]));
    this.notePendingRenames(looked, added, removed, inMove);
    this.noteCues(looked, added);
    this.texts = await this.fetchTexts(looked, added, inMove);
    for (const move of moves) if (this.ready(move.from, move.sha)) await this.guarded(move.from, move.sha, () => this.move(move, said));
    for (const [path, sha] of added) if (!inMove.has(path) && this.ready(path, sha)) await this.guarded(path, sha, () => this.add(looked, path, sha, said));
    const deletes = removed.filter(([path]) => !inMove.has(path));
    const here = deletes.filter(([path]) => looked.files.has(path)).map(([path]) => path);
    const still = new Set(here);
    for (const path of this.releasedDeletes) if (!still.has(path)) this.releasedDeletes.delete(path);
    const asked = here.filter((path) => !this.releasedDeletes.has(path));
    const holdDeletes = asked.length > BURST_FILES;
    if (holdDeletes && this.announcedDeletes !== asked.length) {
      this.announcedDeletes = asked.length;
      const release = (): void => {
        for (const path of asked) this.releasedDeletes.add(path);
        this.ctx.ports.heldDeletes?.(null);
        this.ctx.ports.lookAgain();
      };
      const words = heldDeletesWords(asked.length);
      if (this.ctx.ports.aware()) {
        this.ctx.ports.heldDeletes?.({ count: asked.length, move: release });
        this.ctx.ports.notify(words, { label: "Show them", run: () => this.ctx.ports.openStatus?.(), lasting: true });
      } else this.ctx.ports.notify(words, { label: "Move them to the trash", run: release });
    }
    if (!holdDeletes) {
      if (this.announcedDeletes !== 0) this.ctx.ports.heldDeletes?.(null);
      this.announcedDeletes = 0;
    }
    this.gone = await this.confirmGone(looked, deletes, holdDeletes);
    for (const [path, sha] of deletes) {
      if (holdDeletes && looked.files.has(path) && !this.releasedDeletes.has(path)) continue;
      if (this.ready(path, sha)) await this.guarded(path, sha, () => this.remove(looked, path, sha, said));
    }
    this.tellStuck();
    state.save();
    if (!silent) this.tell(said);
    return { changed: said.updated.length + said.merged.length + said.created.length + said.moved.length + said.trashed.length, more: this.cut };
  }

  async bringIn(looked: Looked, path: string): Promise<boolean> {
    const sha = looked.repo.get(path);
    const entry = looked.files.get(path);
    if (sha === undefined || !entry || entry.sha === sha || !unchangedHere(entry)) return false;
    this.looked = looked;
    this.reads = 0;
    this.waiting.delete(path);
    const said: Said = { updated: [], merged: [], created: [], moved: [], trashed: [], came: [] };
    await this.guarded(path, sha, () => this.add(looked, path, sha, said));
    this.ctx.state.save();
    return said.updated.length > 0;
  }

  private async fetchTexts(looked: Looked, added: Array<[string, string]>, inMove: ReadonlySet<string>): Promise<Map<string, string>> {
    const { ports } = this.ctx;
    if (!ports.blobTexts) return new Map();
    const asked: Array<{ doc: DocumentRef; sha: string }> = [];
    const seen = new Set<string>();
    for (const [path, sha] of added) {
      const doc = ports.documentFor(path);
      const entry = looked.files.get(path);
      if (!doc || inMove.has(path) || seen.has(sha) || entry?.sha === sha || !this.ready(path, sha, false) || (entry && this.followsDraft(looked, path, doc, entry.sentTo))) continue;
      seen.add(sha);
      asked.push({ doc, sha });
      if (asked.length >= TEXTS_PER_PASS) break;
    }
    if (asked.length === 0) return new Map();
    this.reads++;
    return ports.blobTexts(asked);
  }

  textOf(sha: string): string | undefined {
    return this.texts.get(sha);
  }

  private async confirmGone(looked: Looked, deletes: Array<[string, string]>, hold: boolean): Promise<Map<string, boolean> | null> {
    const { ports } = this.ctx;
    if (!ports.confirmGone) return null;
    const asked: DocumentRef[] = [];
    for (const [path, sha] of deletes) {
      const entry = looked.files.get(path);
      const doc = ports.documentFor(path);
      if (!entry || !doc || looked.repo.has(path) || (hold && !this.releasedDeletes.has(path)) || (entry.sha !== sha && !unchangedHere(entry)) || !this.ready(path, sha, false)) continue;
      asked.push(doc);
    }
    if (asked.length === 0) return new Map();
    this.reads++;
    return ports.confirmGone(asked);
  }

  private async guarded(path: string, sha: string, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch {
      this.ctx.activity.notWritten(path);
      this.ctx.ports.diagnose("a change from main could not be made");
      this.wait(path, sha);
    }
  }

  private ready(path: string, sha: string, spend = true): boolean {
    if (!this.ctx.current()) return false;
    const waited = this.waiting.get(path);
    if (waited && waited.sha === sha && this.ctx.ports.now() < waited.until) return false;
    if (this.declined.get(path) === sha || this.announced.get(path) === sha || this.deciding.has(path)) return false;
    if (spend && this.reads >= READS_PER_PASS) {
      this.cut = true;
      return false;
    }
    return true;
  }

  private wait(path: string, sha: string): void {
    const before = this.waiting.get(path);
    const strikes = before && before.sha === sha ? before.strikes + 1 : 0;
    this.waiting.set(path, { sha, strikes, until: this.ctx.ports.now() + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** strikes) });
  }

  private settled(path: string, sha: string | null): void {
    this.waiting.delete(path);
    this.cues.delete(path);
    this.announced.delete(path);
    this.reviewTold.delete(path);
    this.pendingRenames.delete(path);
    const guessed = this.ctx.state.data.guessed;
    if (guessed.includes(path)) this.ctx.state.data.guessed = guessed.filter((one) => one !== path);
    const seen = this.ctx.state.data.seen;
    if (!seen || !this.ctx.current()) return;
    if (sha === null) delete seen[path];
    else seen[path] = sha;
  }

  private tell(said: Said): void {
    const parts: string[] = [];
    const list = (names: string[], verb: string): void => {
      if (names.length) parts.push(`${verb} ${names.length === 1 ? names[0]! : `${names.length} notes`}`);
    };
    list(said.updated, "Updated");
    list(said.merged, "Merged GitHub's changes into");
    list(said.created, "Added");
    list(said.moved, "Renamed");
    const matched = parts.length ? [`${parts.join(". ")}, to match GitHub.`] : [];
    const trashed = said.trashed.length ? [trashedWords(said.trashed)] : [];
    if (matched.length + trashed.length === 0) return;
    const message = [...matched, ...trashed].join(" ");
    const { ports } = this.ctx;
    if (ports.seeChanges && said.came.length) ports.notify(message, { label: "See changes", run: () => ports.seeChanges?.(said.came.flatMap(({ name, shown }) => (said.came.length > 1 ? [{ kind: "heading" as const, text: name }, ...shown] : shown))) });
    else ports.notify(message);
  }

  private noteCues(looked: Looked, added: Array<[string, string]>): void {
    const seen = this.ctx.state.data.seen!;
    const now = this.ctx.ports.now();
    const here = new Set<string>();
    for (const [path, sha] of added) {
      const entry = looked.files.get(path);
      if (!entry || entry.sha === sha || entry.sha === seen[path] || unchangedHere(entry)) continue;
      here.add(path);
      if (this.cues.get(path)?.sha !== sha) this.cues.set(path, { sha, since: now, told: false });
    }
    for (const path of [...this.cues.keys()]) if (!here.has(path)) this.cues.delete(path);
    for (const path of [...this.choices]) if (!here.has(path)) this.dropChoice(path);
  }

  private readonly choices = new Set<string>();

  private askChoice(path: string, words: string, label: string, run: () => void, notice: string, plain: string = notice): void {
    if (!this.ctx.ports.aware()) {
      this.ctx.ports.notify(plain, { label, run, lasting: true });
      return;
    }
    this.choices.add(path);
    this.ctx.ports.choice?.(path, { words, label, run });
    this.ctx.ports.notify(notice, { label: CHOICE_WORDS.show, run: () => this.ctx.ports.openStatus?.(), lasting: true });
  }

  private dropChoice(path: string): void {
    if (this.choices.delete(path)) this.ctx.ports.choice?.(path, null);
  }

  private tellStuck(): void {
    const now = this.ctx.ports.now();
    for (const [path, cue] of this.cues) {
      if (cue.told || now - cue.since < STUCK_MS || this.declined.get(path) === cue.sha || this.announced.get(path) === cue.sha || this.reviewTold.get(path) === cue.sha || this.deciding.has(path)) continue;
      cue.told = true;
      this.askChoice(path, CHOICE_WORDS.main, CHOICE_WORDS.choose, () => this.settleNow(path, cue.sha), `${noteName(path)} changed on GitHub, and you changed it here too. Stay connected hasn't been able to merge the two yet.`);
    }
  }

  private settleNow(path: string, sha: string): void {
    const looked = this.looked;
    if (!looked || !this.ctx.current()) return;
    this.waiting.delete(path);
    this.declined.delete(path);
    this.announced.delete(path);
    this.opening.add(path);
    void (async () => {
      const said: Said = { updated: [], merged: [], created: [], moved: [], trashed: [], came: [] };
      this.reads = 0;
      await this.guarded(path, sha, () => this.add(looked, path, sha, said));
      this.tell(said);
      this.ctx.state.save();
      this.ctx.ports.lookAgain();
      if (this.ctx.state.data.seen?.[path] !== sha && !this.deciding.has(path) && !this.declined.has(path)) {
        this.ctx.ports.notify(`specgit couldn't merge ${noteName(path)} with the changes on GitHub just now. It stays in the Status tab, where you can catch it up.`);
      }
      this.opening.delete(path);
    })();
  }

  private notePendingRenames(looked: Looked, added: Array<[string, string]>, removed: Array<[string, string]>, inMove: ReadonlySet<string>): void {
    const seen = this.ctx.state.data.seen!;
    for (const path of [...this.pendingRenames.keys()]) if (looked.repo.has(path)) this.pendingRenames.delete(path);
    const removedBySha = new Map<string, string[]>();
    for (const [from, sha] of removed) {
      if (inMove.has(from) || sha === "" || sha === EMPTY_BLOB) continue;
      const entry = looked.files.get(from);
      if (!entry || entry.sha === sha || unchangedHere(entry)) continue;
      removedBySha.set(sha, [...(removedBySha.get(sha) ?? []), from]);
    }
    const addedBySha = new Map<string, string[]>();
    for (const [path, sha] of added) {
      if (inMove.has(path) || seen[path] !== undefined || sha === "" || sha === EMPTY_BLOB) continue;
      addedBySha.set(sha, [...(addedBySha.get(sha) ?? []), path]);
    }
    for (const [sha, froms] of removedBySha) {
      if (froms.length !== 1) continue;
      const tos = addedBySha.get(sha);
      if (!tos || tos.length !== 1) continue;
      this.pendingRenames.set(froms[0]!, { to: tos[0]!, sha });
    }
  }

  private pairMoves(looked: Looked, added: Array<[string, string]>, removed: Array<[string, string]>): Array<{ from: string; to: string; sha: string; held: string }> {
    const taken = new Set<string>();
    const moves: Array<{ from: string; to: string; sha: string; held: string }> = [];
    const seen = this.ctx.state.data.seen!;
    for (const [from, sha] of removed) {
      const to = added.find(([path, other]) => other === sha && seen[path] === undefined && !taken.has(path) && !looked.files.has(path));
      const entry = looked.files.get(from);
      if (!to || !entry || (entry.sha !== sha && !unchangedHere(entry))) continue;
      taken.add(to[0]);
      moves.push({ from, to: to[0], sha, held: entry.sha });
    }
    return moves;
  }

  private async free(path: string, doc: DocumentRef, sha: string): Promise<boolean> {
    const { ports } = this.ctx;
    if ((await notWritableBecause({ phaseOf: (one) => ports.phaseOf(one), hasUnsavedText: (one) => ports.vault.hasUnsavedText(one) }, path)) !== null) return this.notFree(path, sha);
    const drafts = this.looked?.drafts;
    const review = drafts?.level && !ports.inGroup(path) ? (drafts.byPath.has(path) ? "open" : "none") : await this.readReview(doc);
    if (review === "none") return true;
    if (review === "open") this.tellReview(path, sha);
    return this.notFree(path, sha);
  }

  private async readReview(doc: DocumentRef): ReturnType<StayPorts["reviewOf"]> {
    this.reads++;
    return this.ctx.ports.reviewOf(doc);
  }

  private tellReview(path: string, sha: string): void {
    const entry = this.looked?.files.get(path);
    const seen = this.ctx.state.data.seen?.[path];
    if (!entry || entry.sha === sha || entry.sha === seen || unchangedHere(entry) || this.reviewTold.get(path) === sha) return;
    this.reviewTold.set(path, sha);
    this.askChoice(path, CHOICE_WORDS.review, CHOICE_WORDS.catchUp, () => this.ctx.ports.settleReview(path), `${noteName(path)} is in review and was also changed on GitHub. Catch up adds the GitHub changes, and asks only about places you both changed.`, `${noteName(path)} changed on GitHub while in review. Click Catch up to bring the changes in.`);
  }

  private unwritten(path: string, sha: string, ...also: string[]): void {
    this.ctx.activity.notWritten(path, ...also);
    this.wait(path, sha);
  }

  private keepAsBase(path: string, doc: DocumentRef, main: MainText): void {
    if (!this.ctx.current()) return;
    this.ctx.ports.recordBase(path, doc, toLf(main.text), main.text);
    this.ctx.ports.rebase(path, main.sha);
  }

  private notFree(path: string, sha: string): false {
    this.wait(path, sha);
    return false;
  }

  private async add(looked: Looked, path: string, sha: string, said: Said): Promise<void> {
    const { ports } = this.ctx;
    const doc = ports.documentFor(path);
    if (!doc) return this.settled(path, sha);
    const entry = looked.files.get(path);
    if (entry?.sha === sha || (!entry && looked.deleted.some((gone) => gone.path === path))) return this.settled(path, sha);
    if (entry && this.followsDraft(looked, path, doc, entry.sentTo)) return this.settled(path, sha);
    if (!(await this.free(path, doc, sha))) return;
    const batched = this.texts.get(sha);
    const main: MainFile = batched !== undefined ? { kind: "file", text: batched, sha } : await this.readMain(doc);
    if (main.kind !== "file" || !this.ctx.current()) return this.wait(path, sha);
    if (entry?.sha === main.sha) return this.settled(path, main.sha);
    if (!entry) return this.create(path, doc, main, said);
    const before = this.ctx.state.data.seen?.[path] ?? null;
    const unchanged = entry.sha === before || unchangedHere(entry);
    return unchanged ? this.update(path, doc, entry.sha, main, said) : this.merge(path, doc, entry.base, before, main, said);
  }

  private followsDraft(looked: Looked, path: string, doc: DocumentRef, sentTo: string | undefined): boolean {
    const { ports } = this.ctx;
    const draft = looked.drafts?.byPath.get(path);
    if (!draft || ports.phaseOf(path) !== "local" || ports.disconnected(doc) || ports.inGroup(path)) return false;
    return follows(draft, ports.login(), sentTo, ports.policy());
  }

  private async readMain(doc: DocumentRef): Promise<MainFile> {
    this.reads++;
    return this.ctx.ports.gitFile(doc);
  }

  private async create(path: string, doc: DocumentRef, main: MainText, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    activity.ownWrite(path);
    if ((await ports.vault.create(path, main.text)) !== "created") return this.unwritten(path, main.sha);
    await this.bring(path, main.text);
    this.keepAsBase(path, doc, main);
    this.settled(path, main.sha);
    said.created.push(noteName(path));
    this.came(said, path, "", main.text);
  }

  private async bring(path: string, text: string): Promise<void> {
    try {
      await this.ctx.ports.bringFor?.(path, text);
    } catch {
      this.ctx.ports.diagnose("the files of main's words could not be brought in");
    }
  }

  private came(said: Said, path: string, before: string, after: string): void {
    const shown = changesBetween(toLf(before), toLf(after));
    if (shown) said.came.push({ name: noteName(path), shown });
  }

  private async update(path: string, doc: DocumentRef, expected: string, main: MainText, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    activity.ownWrite(path);
    let before = "";
    const written = await ports.vault.process(path, (current) => {
      before = current;
      return gitBlobShaOfText(current) === expected ? main.text : null;
    });
    if (written !== "written") return this.unwritten(path, main.sha);
    await this.bring(path, main.text);
    this.came(said, path, before, main.text);
    this.keepAsBase(path, doc, main);
    this.settled(path, main.sha);
    said.updated.push(noteName(path));
  }

  private async merge(path: string, doc: DocumentRef, entryBase: string | null, before: string | null, main: MainText, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    const mine = await ports.vault.read(path);
    if (mine === null) return this.wait(path, main.sha);
    const matched = entryBase ?? (this.ctx.state.data.guessed.includes(path) ? null : before);
    const base = await matchedBase(
      matched,
      (sha) => {
        this.reads++;
        return ports.blobText(doc, sha);
      },
      () => ports.baseText(path, matched),
    );
    const joined = reconcile({ editor: toLf(mine), room: toLf(main.text), base, baseIsGit: false, emptied: false, git: main.text, readOnly: false }, new Budget(400));
    if (joined.kind === "review") return this.askPerson(path, doc, main, mine, joined);
    if (joined.kind !== "text") return this.wait(path, main.sha);
    const merged = withEol(joined.text, eolOf(mine));
    if (merged !== mine) {
      activity.ownWrite(path);
      if ((await ports.vault.process(path, (current) => (current === mine ? merged : null))) !== "written") return this.unwritten(path, main.sha);
      await this.bring(path, merged);
      said.merged.push(noteName(path));
      this.came(said, path, mine, merged);
    }
    this.keepAsBase(path, doc, main);
    this.settled(path, main.sha);
  }

  private askPerson(path: string, doc: DocumentRef, main: MainText, mine: string, joined: { regions: ReviewRequest["regions"]; fromBase: boolean }): void {
    if (this.declined.get(path) === main.sha || this.deciding.has(path)) return;
    if (!this.opening.has(path)) {
      if (this.announced.get(path) === main.sha) return;
      this.announced.set(path, main.sha);
      const cue = this.cues.get(path);
      if (cue) cue.told = true;
      this.askChoice(path, CHOICE_WORDS.main, CHOICE_WORDS.choose, () => this.settleNow(path, main.sha), `${noteName(path)} was changed here and on GitHub, in the same place. Nothing was overwritten.`);
      return;
    }
    this.opening.delete(path);
    this.deciding.add(path);
    const { ports, activity } = this.ctx;
    this.queue = this.queue.then(async () => {
      try {
        if (!this.ctx.current() || this.abort.signal.aborted) return;
        const chosen = await ports.chooseWhatToKeep({ name: noteName(path), regions: joined.regions, fromBase: joined.fromBase, other: "github", settle: () => null, signal: this.abort.signal });
        if (chosen === null) return void this.declined.set(path, main.sha);
        if (!this.ctx.current()) return;
        const text = withEol(chosen, eolOf(mine));
        activity.ownWrite(path);
        if ((await ports.vault.process(path, (current) => (current === mine ? text : null))) !== "written") return this.unwritten(path, main.sha);
        await this.bring(path, text);
        this.keepAsBase(path, doc, main);
        this.settled(path, main.sha);
        this.ctx.state.save();
        ports.lookAgain();
      } catch {
        this.wait(path, main.sha);
      } finally {
        this.deciding.delete(path);
      }
    });
  }

  private async move(move: { from: string; to: string; sha: string; held: string }, said: Said): Promise<void> {
    const { ports, activity } = this.ctx;
    const [from, to] = [ports.documentFor(move.from), ports.documentFor(move.to)];
    if (!from || !to) return this.settled(move.from, null);
    if (ports.phaseOf(move.to) !== "local" || !(await this.free(move.from, from, move.sha))) return this.wait(move.from, move.sha);
    const mirror = this.looked?.repo;
    if (!mirror || mirror.has(move.from) || mirror.get(move.to) !== move.sha || !this.ctx.current()) return this.wait(move.from, move.sha);
    const current = await ports.vault.read(move.from);
    if (current === null || gitBlobShaOfText(current) !== move.held || ports.vault.exists(move.to)) return this.wait(move.from, move.sha);
    activity.ownWrite(move.from, move.to);
    if ((await ports.vault.rename(move.from, move.to)) !== "renamed") return this.unwritten(move.from, move.sha, move.to);
    this.settled(move.from, null);
    this.settled(move.to, move.sha);
    said.moved.push(noteName(move.to));
  }

  private async remove(looked: Looked, path: string, sha: string, said: Said): Promise<void> {
    const { ports, state, activity } = this.ctx;
    const entry = looked.files.get(path);
    const doc = ports.documentFor(path);
    if (!entry || !doc) return this.settled(path, null);
    if (entry.sha !== sha && !unchangedHere(entry)) {
      if (!state.data.kept.includes(path)) state.data.kept.push(path);
      const moved = this.pendingRenames.get(path);
      if (moved !== undefined && moved.sha === sha) {
        const key = `${path}|${moved.to}|${sha}`;
        if (!this.renameTold.has(key)) {
          this.renameTold.add(key);
          ports.notify(DRAFT_SAID.renameKept(noteName(path), noteName(moved.to)));
        }
      }
      return this.settled(path, null);
    }
    if (!(await this.free(path, doc, sha))) return;
    const mirror = looked.repo.get(path);
    if (mirror !== undefined) return this.settled(path, mirror);
    if (this.gone !== null) {
      const there = this.gone.get(path);
      if (there !== false || !this.ctx.current()) return this.wait(path, sha);
    } else {
      this.reads++;
      const main = await ports.gitFile(doc);
      if (main.kind === "file") return this.settled(path, main.sha);
      if (main.kind !== "absent" || !this.ctx.current()) return this.wait(path, sha);
    }
    activity.ownWrite(path);
    if (!(await ports.vault.trash(path, entry.sha))) return this.unwritten(path, sha);
    this.settled(path, null);
    said.trashed.push(noteName(path));
  }
}
