import { docKey, noteName } from "../mapping";
import type { StepResult } from "../review/review-api";
import { STOP_REVIEW } from "../review/words";
import { abandonGroupConfirm } from "../shared/review-flow";
import type { Dialogs, FlowDeps } from "./flow-deps";
import { failure, REVIEW_UNCHECKED, REVIEW_UNCHECKED_TITLE } from "./flow-helpers";
import { matchedBase } from "./merge-base";
import type { ChangeRow, ChangesModel, Doing } from "./model";
import { isRoomed } from "./roomed";
import { unitKey } from "../shared/review-flow";

export interface StopReviewHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
  busy<T>(work: () => Promise<T>, doing: Doing): Promise<T>;
  alert(options: Parameters<Dialogs["alert"]>[0]): Promise<void>;

  readReviews(files: readonly ChangeRow[]): Promise<ChangeRow[]>;

  forget(path: string): void;
  closeReviews(rows: readonly ChangeRow[], step?: string): Promise<{ closed: ChangeRow[]; failed: { row: ChangeRow; result: Extract<StepResult, { ok: false }> } | null }>;
}

export class StopReview {
  constructor(private readonly host: StopReviewHost) {}

  async run(asked: readonly ChangeRow[]): Promise<void> {
    const { deps, model } = this.host;

    const files = asked.filter((row) => !row.group && !model.groupOf(row.change.path));
    if (files.length === 0) return;
    const rows = await this.host.readReviews(files);

    const unchecked = rows.filter((row) => row.unchecked === true);
    if (unchecked.length > 0) return this.host.alert({ title: REVIEW_UNCHECKED_TITLE, description: REVIEW_UNCHECKED(unchecked.map((row) => noteName(row.change.path))) });

    const shown = new Map(files.map((row) => [row.change.path, row.entry?.prNumber ?? null]));
    const moved = rows.filter((row) => row.entry === null || row.entry.prNumber !== shown.get(row.change.path));
    if (moved.length > 0) return this.host.alert({ title: STOP_REVIEW.moved.title, description: moved.length === 1 ? STOP_REVIEW.moved.one(noteName(moved[0]!.change.path)) : STOP_REVIEW.moved.many });
    const one = rows.length === 1;
    const ok = await deps.dialogs.confirm({
      title: one ? STOP_REVIEW.title(noteName(rows[0]!.change.path)) : STOP_REVIEW.titleMany(rows.length),
      points: one ? STOP_REVIEW.points : STOP_REVIEW.pointsMany,
      confirmLabel: one ? STOP_REVIEW.confirm : STOP_REVIEW.confirmMany(rows.length),
      destructive: true,
    });
    if (!ok) return;
    await this.host.busy(
      async () => {

        const bases = new Map<string, string>();
        for (const row of rows) {
          const base = await this.baseOf(row);
          if (base === null) return this.host.alert({ title: STOP_REVIEW.failed, description: STOP_REVIEW.needsGitHub });
          bases.set(row.change.path, base);
        }
        for (const row of rows) {
          const failed = await this.close(row, bases.get(row.change.path)!);
          if (failed) return this.host.alert({ title: STOP_REVIEW.failed, description: failure(failed, STOP_REVIEW.failed) });
        }
        deps.dialogs.toast(STOP_REVIEW.done.title, STOP_REVIEW.done.description);
      },
      { words: STOP_REVIEW.busy, paths: rows.map((row) => row.change.path) },
    );
  }

  async runGroup(group: ChangeRow): Promise<void> {
    const { deps, model } = this.host;
    const info = group.group;
    if (!info) return;
    const { id, overview, files, members } = info;
    const words = abandonGroupConfirm(overview.name, files.length, "note");
    if (!(await deps.dialogs.confirm({ title: words.title, description: words.description, confirmLabel: words.confirm, destructive: true }))) return;
    const repo = group.doc.repo;
    const wasChecked = model.isSelected(unitKey(group.unit));
    await this.host.busy(
      async () => {
        const bases = new Map<string, string>();
        for (const row of members) {
          const base = await this.baseOf(row);
          if (base === null) return this.host.alert({ title: STOP_REVIEW.failed, description: STOP_REVIEW.needsGitHub });
          bases.set(row.change.path, base);
        }
        const taken = members.map((row) => {
          const key = docKey(row.doc);

          const roomed = isRoomed(deps, row.change.path);
          const step = deps.ownRestarts.expect(key, bases.get(row.change.path)!);
          return { row, key, step, putBack: roomed ? deps.keepBase(row.change.path, row.doc, bases.get(row.change.path)!) : null };
        });
        let how: "ok" | "unsure" | "refused" = "unsure";
        let failed: Extract<StepResult, { ok: false }> | null = null;
        try {
          const result = await deps.review.group(repo, "abandon", { id });
          if (result.ok) how = "ok";
          else {
            failed = result;
            if (result.status >= 400 && result.status < 500) how = "refused";
          }
        } finally {
          for (const { row, key, step, putBack } of taken) {
            if (how === "refused") {
              putBack?.();
              deps.ownRestarts.done(key, [step]);
            } else {
              deps.ownRestarts.sent(key, step, how);
              deps.stopped?.(row.change.path);
            }
          }
        }
        if (failed) return this.host.alert({ title: STOP_REVIEW.failed, description: failure(failed, STOP_REVIEW.failed) });

        model.leftGroup(files.map((file) => file.path), wasChecked);
        for (const { row } of taken) {
          this.host.forget(row.change.path);
          model.learnSent(row.change.path, null);
          model.learn(row.change.path, { reviewBranch: null, pr: null });
        }
        void model.refresh();
        deps.dialogs.toast(STOP_REVIEW.done.title, STOP_REVIEW.done.description);
      },
      { words: STOP_REVIEW.busy, paths: files.map((file) => file.path) },
    );
  }

  private async baseOf(row: ChangeRow): Promise<string | null> {
    const { deps } = this.host;
    if (row.change.base !== null) return matchedBase(row.change.base, (sha) => deps.gitBlob(row.doc, sha), () => null);
    const main = await deps.gitFile(row.doc);
    if (main.kind === "unreadable") return null;
    return main.kind === "file" ? main.text : "";
  }

  private async close(row: ChangeRow, base: string): Promise<Extract<StepResult, { ok: false }> | null> {
    const { deps } = this.host;
    const key = docKey(row.doc);

    const roomed = isRoomed(deps, row.change.path);
    const step = deps.ownRestarts.expect(key, base);
    const putBack = roomed ? deps.keepBase(row.change.path, row.doc, base) : null;

    let how: "ok" | "unsure" | "refused" = "unsure";
    try {
      const { failed } = await this.host.closeReviews([row], step);
      if (failed === null) how = "ok";
      else if (failed.result.status >= 400 && failed.result.status < 500) how = "refused";
      return failed?.result ?? null;
    } finally {
      if (how === "refused") {
        putBack?.();

        deps.ownRestarts.done(key, [step]);
      } else {
        deps.ownRestarts.sent(key, step, how);

        deps.stopped?.(row.change.path);
      }
    }
  }
}
