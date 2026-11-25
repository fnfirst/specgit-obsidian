import { FILES_PER_BATCH } from "./copy-in";
import { isOwnDraft, teammateReview } from "./batch-reviews";
import { gitBlobShaOfText } from "./blob-sha";
import { toLf } from "../disk/line-endings";
import { CasePathIndex, type DocumentRef, noteName } from "../mapping";
import { isLostAnswerResult, reviewIsOpen, type StepResult } from "../review/review-api";
import { discardAsk, type DiscardCounts, type DiscardResult, type DiscardWorld, discardedWords, DISCARD, discardTitle, type LeftAlone, nothingToDiscard, type SkipReason } from "./discard-words";
import type { Dialogs, FlowDeps } from "./flow-deps";
import type { ChangeRow, ChangesModel, Doing as BusyDoing } from "./model";
import { isRoomed } from "./roomed";
import { isAnotherAuthor } from "./review-owner";
import type { SentMemory } from "./sent-memory";

export interface DiscardHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
  readonly memory: SentMemory;
  busy<T>(work: () => Promise<T>, doing: BusyDoing): Promise<T>;
  alert(options: Parameters<Dialogs["alert"]>[0]): Promise<void>;
  readReviews(files: readonly ChangeRow[]): Promise<ChangeRow[]>;
  readReviewsFromMap(files: readonly ChangeRow[]): Promise<ChangeRow[]>;
  inReviewOfSomeoneElse(row: ChangeRow): boolean;
  closeReviews(rows: readonly ChangeRow[], step?: string, expectPr?: number | null): Promise<{ closed: ChangeRow[]; failed: { row: ChangeRow; result: Extract<StepResult, { ok: false }> } | null }>;
}

type Plan = Doing | { kind: "skip"; row: ChangeRow; why: SkipReason };
type StillOpen = { why: "review" | "reviewChanged" | "reviewUnsure"; pr: number; elsewhere: boolean; grouped: boolean };
type Doing =
  | { kind: "restore"; row: ChangeRow; original: DocumentRef; mine: string; roomed: boolean }
  | { kind: "recreate"; row: ChangeRow; original: DocumentRef; roomed: boolean }
  | { kind: "trash"; row: ChangeRow; original: DocumentRef; mine: string; roomed: boolean }
  | { kind: "rename"; row: ChangeRow; original: DocumentRef; mine: string; roomed: boolean };

export function discardFiles(asked: readonly ChangeRow[]): ChangeRow[] {
  const seen = new Set<string>();
  const out: ChangeRow[] = [];
  for (const row of asked) {
    for (const file of row.group ? row.group.members : [row]) {
      if (seen.has(file.change.path)) continue;
      seen.add(file.change.path);
      out.push(file);
    }
  }
  return out;
}

const reviewed = (row: ChangeRow): boolean => row.entry !== null;
const withName = (plan: Plan): string => noteName(plan.row.change.path);

export class Discard {
  constructor(private readonly host: DiscardHost) {}

  async run(asked: readonly ChangeRow[]): Promise<void> {
    const { deps, model } = this.host;
    if (model.state().busy) return;
    const files = discardFiles(asked);
    if (files.length === 0) {
      const said = nothingToDiscard(model.state().phase);
      return deps.dialogs.toast(said.title, said.description);
    }
    const rows = await this.host.readReviewsFromMap(files);
    const plans = await Promise.all(rows.map((row) => this.plan(row)));
    const left: LeftAlone[] = plans.flatMap((plan) => (plan.kind === "skip" ? [{ name: withName(plan), why: plan.why }] : []));
    const todo = plans.filter((plan): plan is Doing => plan.kind !== "skip");
    const world: DiscardWorld = { deletesForGood: deps.deletesForGood() };
    if (todo.length === 0) return this.say(this.result(left), world);
    const place = model.placeNow();
    const ok = await deps.dialogs.confirm({
      title: discardTitle(todo.length, noteName(todo[0]!.row.change.path)),
      ...discardAsk(this.count(todo), world, left),
      confirmLabel: DISCARD.confirm,
      destructive: true,
    });
    if (!ok) return;
    const result = await this.host.busy(() => this.carryOut(plans, place), { words: DISCARD.busy, paths: todo.map((plan) => plan.row.change.path) });
    await this.say(result, world);
  }

  private async say(result: DiscardResult, world: DiscardWorld): Promise<void> {
    const said = discardedWords(result, world);
    if (result.skipped.length > 0) await this.host.alert(said);
    else this.host.deps.dialogs.toast(said.title, said.description);
  }

  private result(skipped: readonly LeftAlone[]): DiscardResult {
    return { restored: 0, trashed: 0, broughtBack: 0, reviewsClosed: 0, skipped: [...skipped] };
  }

  private async allowed(path: string): Promise<SkipReason | null> {
    const { deps } = this.host;
    const phase = deps.phaseOf(path);
    if (phase === "joining") return "connecting";
    if (phase === "blocked" || phase === "locked") return "stuck";
    return (await deps.vault.hasUnsavedText(path)) ? "held" : null;
  }

  private collidesCase(target: string, excludeFrom?: string): boolean {
    const { deps, model } = this.host;
    if (deps.vault.collidesCase) return deps.vault.collidesCase(target, excludeFrom);
    const files = model.vault()?.files.keys();
    return files !== undefined && CasePathIndex.fromPaths(files, deps.vault.loadedEntries?.()).collision(target, excludeFrom) !== null;
  }

  private async plan(row: ChangeRow): Promise<Plan> {
    const { deps } = this.host;
    const { change } = row;
    const original = change.kind === "renamed" && change.from ? deps.documentFor(change.from) : row.doc;
    if (!original) return { kind: "skip", row, why: "unmapped" };
    if (row.unread) return { kind: "skip", row, why: "unchecked" };
    if (this.host.inReviewOfSomeoneElse(row)) return { kind: "skip", row, why: "theirs" };
    const roomed = isRoomed(deps, change.path);
    if (roomed && row.theirs) return { kind: "skip", row, why: "theirs" };
    if (roomed && this.host.model.offline()) return { kind: "skip", row, why: "unreachable" };
    if (change.kind === "deleted") {
      if (deps.vault.exists(change.path) || this.collidesCase(change.path)) return { kind: "skip", row, why: "exists" };
      return { kind: "recreate", row, original, roomed };
    }
    const why = await this.allowed(change.path);
    if (why !== null) return { kind: "skip", row, why };
    const mine = await deps.readText(change.path);
    if (mine === null) return { kind: "skip", row, why: "gone" };
    switch (change.kind) {
      case "new":
        return { kind: "trash", row, original, mine, roomed };
      case "renamed": {
        const back = change.from!;
        if (deps.vault.exists(back) || this.collidesCase(back, change.path)) return { kind: "skip", row, why: "exists" };
        return { kind: "rename", row, original, mine, roomed };
      }
      default:
        return { kind: "restore", row, original, mine, roomed };
    }
  }

  private count(plans: readonly Doing[]): DiscardCounts {
    const rows = plans.map((plan) => plan.row);
    const roomedPlans = plans.filter((plan) => plan.roomed);
    const of = (kind: ChangeRow["change"]["kind"]): number => rows.filter((row) => row.change.kind === kind).length;
    return { edited: of("edited"), renamed: of("renamed"), added: of("new"), deleted: of("deleted"), reviews: rows.filter(reviewed).length, roomed: roomedPlans.length, roomedNew: roomedPlans.filter((plan) => plan.row.change.kind === "new").length, others: roomedPlans.reduce((sum, plan) => sum + this.host.deps.othersHere(plan.row.change.path), 0), grouped: rows.filter((row) => this.host.model.groupOf(row.change.path) !== undefined).length };
  }

  private async prefetch(plans: readonly Plan[]): Promise<Map<string, { text: string; sha: string }>> {
    const { deps, model } = this.host;
    const found = new Map<string, { text: string; sha: string }>();
    const commit = model.copyOptions().commit;
    if (!deps.gitBlobs || commit === null || commit === undefined) return found;
    const states = model.vault();
    const wanted = plans.flatMap((plan) => {
      if (plan.kind === "skip" || plan.kind === "trash" || plan.kind === "recreate") return [];
      const sha = plan.row.change.kind === "renamed" ? states?.files.get(plan.row.change.from ?? "")?.repoSha : plan.row.change.repoSha;
      return sha ? [{ sha, path: plan.original.path, repo: plan.original.repo }] : [];
    });
    for (let at = 0; at < wanted.length; at += FILES_PER_BATCH) {
      const run = wanted.slice(at, at + FILES_PER_BATCH);
      const answer = await deps.gitBlobs(run[0]!.repo, commit, run.map(({ sha, path }) => ({ sha, path })));
      if (answer.kind !== "answered") break;
      for (const { sha, path } of run) {
        const read = answer.files.get(sha);
        if (read?.kind === "text") found.set(path, { text: read.text, sha });
      }
    }
    return found;
  }

  private async carryOut(plans: readonly Plan[], place: string): Promise<DiscardResult> {
    this.prefetched = await this.prefetch(plans);
    const result = this.result(plans.flatMap((plan) => (plan.kind === "skip" ? [{ name: withName(plan), why: plan.why }] : [])));
    for (const plan of plans) {
      if (plan.kind === "skip") continue;
      const why = this.host.model.placeNow() !== place ? "place" : await this.one(plan, result);
      if (why !== null) result.skipped.push(typeof why === "string" ? { name: withName(plan), why } : { name: withName(plan), ...why });
    }
    return result;
  }

  private prefetched = new Map<string, { text: string; sha: string }>();

  private async mainText(doc: DocumentRef): Promise<{ text: string; sha: string } | SkipReason> {
    const given = this.prefetched.get(doc.path);
    if (given) return given;
    const main = await this.host.deps.gitFile(doc);
    if (main.kind === "unreadable") return "unreadable";
    if (main.kind === "absent") return "absent";
    return { text: main.text, sha: main.sha };
  }

  private async one(plan: Doing, result: DiscardResult): Promise<SkipReason | StillOpen | null> {
    const { deps } = this.host;
    const { row, original } = plan;
    const { change } = row;
    let github: { text: string; sha: string } | null = null;
    if (plan.kind !== "trash") {
      const main = await this.mainText(original);
      if (typeof main === "string") return main;
      github = main;
    }
    const now = await deps.readText(change.path);
    if (plan.kind === "recreate" ? now !== null : now === null) return plan.kind === "recreate" ? "exists" : "gone";
    if (plan.kind === "recreate" && this.collidesCase(change.path)) return "exists";
    if (plan.kind === "rename" && (deps.vault.exists(change.from!) || this.collidesCase(change.from!, change.path))) return "exists";
    if (plan.kind !== "recreate") {
      if (toLf(now ?? "") !== toLf(plan.mine)) return "changed";
      const why = await this.allowed(change.path);
      if (why !== null) return why;
    }
    const roomed = plan.roomed || isRoomed(deps, change.path);
    let own: number | null = row.entry?.prNumber ?? null;
    if (own !== null && own > 0) {
      const checked = await this.checkOwn(row);
      if (typeof checked === "string") return checked;
      own = checked.pr;
    }
    if (roomed && own === null) {
      const whose = await this.whose(row);
      if (typeof whose === "object") own = whose.pr;
      else if (whose !== "none" && whose !== "draft") return whose;
      else {
        const live = deps.phaseOf(change.path) === "live";
        const { failed } = await this.host.closeReviews([row], undefined, null);
        if (failed) return "notReset";
        const refused = await this.write(plan, github, result);
        if ((refused === "changed" || refused === "held") && plan.kind === "restore" && live) {
          result.restored++;
          return "keptTyping";
        }
        return refused;
      }
    }
    const done = await this.write(plan, github, result);
    if (done !== null) return done;
    if (own !== null) {
      const { failed } = await this.host.closeReviews([row], undefined, own > 0 ? own : undefined);
      const changed = !failed ? false : failed.result.code === "review_changed";
      if (failed) return { why: isLostAnswerResult(failed.result) ? "reviewUnsure" : changed ? "reviewChanged" : "review", pr: own, elsewhere: plan.kind === "trash" || plan.kind === "rename", grouped: this.host.model.groupOf(change.path) !== undefined };
      result.reviewsClosed++;
    }
    return null;
  }

  private async checkOwn(row: ChangeRow): Promise<{ pr: number | null } | SkipReason> {
    const { deps } = this.host;
    const status = await deps.review.status(row.doc);
    if (status === null) return "unchecked";
    if (!reviewIsOpen(status)) return { pr: null };
    const author = status.pr?.authorLogin;
    if (status.pr && author != null && isAnotherAuthor(author, deps.viewerLogin())) return "theirs";
    return { pr: status.pr && status.pr.number > 0 ? status.pr.number : null };
  }

  private async whose(row: ChangeRow): Promise<{ pr: number } | "draft" | "none" | SkipReason> {
    const { deps } = this.host;
    if (row.theirs) return "theirs";
    const status = await deps.review.status(row.doc);
    if (status === null) return "unchecked";
    if (!reviewIsOpen(status)) return "none";
    const author = status.pr?.authorLogin;
    if (status.pr && author != null) return isAnotherAuthor(author, deps.viewerLogin()) ? "theirs" : { pr: status.pr.number };
    if (deps.phaseOf(row.change.path) === "live") return "draft";
    return status.reviewBranch === null ? "unsure" : this.draftBy(row.doc, status.reviewBranch);
  }

  private async draftBy(doc: DocumentRef, branch: string): Promise<"draft" | "theirs" | "unsure"> {
    const { deps } = this.host;
    const read = await deps.review.groups(doc.repo);
    if (read.kind === "unknown" || !read.paths || read.stale) return "unsure";
    const entries = read.paths[doc.path];
    const login = deps.viewerLogin();
    const groups = new Map(read.kind === "groups" ? Object.entries(read.overviews) : []);
    if (isOwnDraft(entries, branch, login, groups, read.saves)) return "draft";
    return teammateReview(entries, login, groups, read.saves) ? "theirs" : "unsure";
  }

  private async write(plan: Doing, github: { text: string; sha: string } | null, result: DiscardResult): Promise<SkipReason | null> {
    const { deps } = this.host;
    const { change } = plan.row;
    switch (plan.kind) {
      case "restore": {
        const why = await this.rewrite(change.path, plan.mine, github!.text);
        if (why !== null) return why;
        result.restored++;
        this.settled(change.path, plan.original, github!);
        return null;
      }
      case "trash": {
        if (!(await deps.vault.trash(change.path, gitBlobShaOfText(plan.mine)))) return (await deps.readText(change.path)) === plan.mine ? "held" : "changed";
        this.host.model.settledDelete(change.path);
        result.trashed++;
        this.forget(change.path);
        return null;
      }
      case "recreate": {
        const made = await deps.vault.create(change.path, github!.text);
        if (made !== "created") return made === "exists" ? "exists" : "failed";
        result.broughtBack++;
        this.settled(change.path, plan.original, github!);
        return null;
      }
      case "rename": {
        const back = change.from!;
        const moved = await deps.vault.rename(change.path, back);
        if (moved !== "renamed") return moved === "exists" ? "exists" : moved === "gone" ? "gone" : "failed";
        this.host.model.settledDelete(change.path);
        this.forget(change.path);
        const why = await this.rewrite(back, plan.mine, github!.text);
        if (why !== null) return why;
        result.restored++;
        this.settled(back, plan.original, github!);
        return null;
      }
    }
  }

  private async rewrite(path: string, mine: string, text: string): Promise<SkipReason | null> {
    let differs = false;
    let already = false;
    const wrote = await this.host.deps.vault.process(path, (current) => {
      already = toLf(current) === toLf(text);
      differs = toLf(current) !== toLf(mine);
      return already || differs ? null : text;
    });
    if (wrote === "gone") return "gone";
    if (wrote === "written" || already) return null;
    return differs ? "changed" : "held";
  }

  private settled(path: string, doc: DocumentRef, github: { text: string; sha: string }): void {
    this.host.model.rebased(path, github.sha);
    this.host.deps.keepBase(path, doc, github.text);
    this.forget(path);
  }

  private forget(path: string): void {
    this.host.memory.forget(path);
    this.host.model.learnSent(path, null);
    this.host.deps.restored?.(path);
  }
}
