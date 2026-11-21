import { noteName } from "../mapping";
import type { StepResult } from "../review/review-api";
import { COULD_NOT_PUBLISH, deletedWords, type ItemOutcome } from "../shared/review-flow";
import type { FlowDeps } from "./flow-deps";
import { failure } from "./flow-helpers";
import type { ChangeRow } from "./model";

type HeldWhy = "changed" | "gone" | "exists" | "review" | "grouped";

const NOT_RENAMED: Record<HeldWhy, (name: string, from: string) => string> = {
  gone: (_name, from) => `${from} is no longer on GitHub, so it was not renamed.`,
  changed: (_name, from) => `${from} was changed on GitHub after you last had it, so it wasn't renamed. Nothing was lost.`,
  exists: (name, from) => `${name} already exists on GitHub, so ${from} wasn't renamed to it.`,
  review: (_name, from) => `${from} has its own review, so it wasn't renamed with the others. Publish it on its own.`,
  grouped: (_name, from) => `${from} is in a group, so it wasn't renamed. Take it out of the group first. Nothing was lost.`,
};

const NOT_DELETED: Record<HeldWhy, (name: string) => string> = {
  gone: (name) => `${name} was changed on GitHub just now, so it was not deleted. Nothing was removed.`,
  changed: (name) => `${name} was changed on GitHub just now, so it was not deleted. Nothing was removed.`,
  exists: (name) => `${name} was changed on GitHub just now, so it was not deleted. Nothing was removed.`,
  review: (name) => `${name} has a review of its own, so it was not deleted with the others. Nothing was removed.`,
  grouped: (name) => `${name} is in a group, so it was not deleted. Take it out of the group first. Nothing was removed.`,
};

const isHeldWhy = (value: unknown): value is HeldWhy => value === "changed" || value === "gone" || value === "exists" || value === "review" || value === "grouped";

export interface MovesDone {
  outcomes: ItemOutcome[];
  done: ChangeRow[];
  deleteToasts: { title: string; description: string }[];
  linksKept: string[];
  perFile: boolean;
  learned: boolean;
}

export const linksKeptWords = (names: readonly string[]): { title: string; description: string } => ({
  title: "Links not updated",
  description: names.length === 1 ? `${names[0]} moved, but its links to other notes were left as they were. specgit couldn't rewrite that note safely, so check its links.` : `${names.join(", ")} moved, but their links weren't updated. Check them.`,
});

export class MoveFlows {
  constructor(private readonly deps: FlowDeps) {}

  renamesFor(others: readonly ChangeRow[], deletes: readonly ChangeRow[]): ChangeRow[] {
    const renames = others.filter((row) => row.change.kind === "renamed" && row.change.from !== undefined && !row.group && !row.entry && !row.review?.reviewBranch && !row.review?.pr && !row.theirs && this.deps.documentFor(row.change.from) !== null);
    return renames.length + deletes.length >= 2 ? renames : [];
  }

  async knownNeedsReview(renames: readonly ChangeRow[]): Promise<"needs" | "set" | "unknown"> {
    let unknown = false;
    for (const repo of new Set(renames.map((row) => row.doc.repo))) {
      const mine = renames.filter((row) => row.doc.repo === repo);
      const answer = await this.deps.review.movesKnown(repo, { moves: mine.map((row) => ({ path: this.deps.documentFor(row.change.from!)!.path, newPath: row.doc.path, expectMain: row.change.sha })) });
      const body = (answer.ok ? answer.body : (answer.body ?? {})) as { blocked?: unknown; needsApproval?: unknown; takes?: unknown };
      if (!answer.ok && body.blocked === true && body.needsApproval === true) return "needs";
      if (!answer.ok) unknown = true;
      if (answer.ok && body.takes === "unknown") unknown = true;
    }
    return unknown ? "unknown" : "set";
  }

  async publish(renames: readonly ChangeRow[], deletes: readonly ChangeRow[], expectOf: ReadonlyMap<ChangeRow, string>): Promise<MovesDone> {
    const done: MovesDone = { outcomes: [], done: [], deleteToasts: [], linksKept: [], perFile: false, learned: false };
    const repos = [...new Set([...renames, ...deletes].map((row) => row.doc.repo))];
    for (const repo of repos) {
      const ofRepo = (row: ChangeRow): boolean => row.doc.repo === repo;
      await this.publishRepo(repo, renames.filter(ofRepo), deletes.filter(ofRepo), expectOf, done);
    }
    return done;
  }

  private async publishRepo(repo: string, renames: readonly ChangeRow[], deletes: readonly ChangeRow[], expectOf: ReadonlyMap<ChangeRow, string>, into: MovesDone): Promise<void> {
    const fromPath = (row: ChangeRow): string => this.deps.documentFor(row.change.from!)!.path;
    const result = await this.deps.review.moves(repo, {
      moves: renames.map((row) => ({ path: fromPath(row), newPath: row.doc.path, expectMain: row.change.sha })),
      deletes: deletes.map((row) => ({ path: row.doc.path, expectMain: expectOf.get(row) ?? null })),
    });
    const all = [...renames, ...deletes];
    const body = (result.ok ? result.body : (result.body ?? {})) as { moved?: unknown; deleted?: unknown; gone?: unknown; held?: unknown; blocked?: unknown; reason?: unknown };
    if (!result.ok && (body as { refused?: unknown }).refused === true) {
      const why = typeof body.reason === "string" && body.reason ? body.reason : COULD_NOT_PUBLISH;
      for (const row of all) into.outcomes.push({ path: row.change.path, status: "failed", reason: why });
      return;
    }
    if (!result.ok && result.status === 404 && body.blocked !== true) {
      into.perFile = true;
      return;
    }
    if (!result.ok && body.blocked !== true) {
      for (const row of all) into.outcomes.push({ path: row.change.path, status: "failed", reason: this.refusedWords(result) });
      return;
    }
    if (!result.ok && body.blocked === true) {
      into.perFile = true;
      into.learned = (body as { known?: unknown }).known === false;
      return;
    }
    const strings = (value: unknown): Set<string> => new Set(Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);
    const moved = new Set(Array.isArray(body.moved) ? (body.moved as { newPath?: unknown }[]).flatMap((one) => (typeof one.newPath === "string" ? [one.newPath] : [])) : []);
    const deleted = strings(body.deleted);
    const gone = strings(body.gone);
    const held = new Map(Array.isArray(body.held) ? (body.held as { path?: unknown; why?: unknown }[]).flatMap((one) => (typeof one.path === "string" && isHeldWhy(one.why) ? [[one.path, one.why] as const] : [])) : []);
    const unrewritten = strings((body as { unrewritten?: unknown }).unrewritten);
    for (const row of renames) {
      const path = row.change.path;
      const why = held.get(fromPath(row));
      if (moved.has(row.doc.path)) {
        into.outcomes.push({ path, status: "done" });
        into.done.push(row);
        if (unrewritten.has(row.doc.path)) into.linksKept.push(path);
      } else into.outcomes.push({ path, status: "failed", reason: why ? NOT_RENAMED[why](noteName(path), noteName(row.change.from!)) : COULD_NOT_PUBLISH });
    }
    const removed: string[] = [];
    for (const row of deletes) {
      const path = row.change.path;
      const why = held.get(row.doc.path);
      if (gone.has(row.doc.path) || deleted.has(row.doc.path)) {
        this.deps.model.settledDelete(path);
        into.done.push(row);
        into.outcomes.push({ path, status: "done" });
        if (deleted.has(row.doc.path)) removed.push(path);
      } else into.outcomes.push({ path, status: "failed", reason: why ? NOT_DELETED[why](noteName(path)) : COULD_NOT_PUBLISH });
    }
    if (removed.length === 1) into.deleteToasts.push(deletedWords(/\.canvas$/i.test(removed[0]!) ? "board" : "note", removed[0]!, null, 0));
    else if (removed.length > 1) into.deleteToasts.push({ title: "Files deleted", description: `${removed.length} files were removed.` });
  }

  private refusedWords(result: Extract<StepResult, { ok: false }>): string {
    return failure(result, COULD_NOT_PUBLISH);
  }
}
