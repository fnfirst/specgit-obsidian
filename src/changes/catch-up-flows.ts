import { Budget } from "../disk/diff";
import { toLf } from "../disk/line-endings";
import { buildReviewRequest, mergeFile } from "../disk/structured-merge";
import { noteName } from "../mapping";
import { CATCH_UP, type CatchUpPreview } from "../shared/review-flow";
import { CATCH_UP_HERE } from "../review/words";
import type { Dialogs, FlowDeps } from "./flow-deps";
import { failure, UNREADABLE, type Sent } from "./flow-helpers";
import { mergedWith } from "./note-merge";
import type { ChangeRow, ChangesModel, Doing } from "./model";
import type { SentMemory } from "./sent-memory";

type Behind = Extract<CatchUpPreview, { kind: "behind" }>;

export interface CatchUpHost {
  readonly deps: FlowDeps;
  readonly model: ChangesModel;
  readonly memory: SentMemory;
  busy<T>(work: () => Promise<T>, doing: Doing): Promise<T>;
  alert(options: Parameters<Dialogs["alert"]>[0]): Promise<void>;
  send(row: ChangeRow, options: { toReview?: boolean; afresh?: boolean }): Promise<Sent>;
}

export interface CatchUpAsked {
  asked?: boolean;
}

export class CatchUpFlows {
  constructor(private readonly host: CatchUpHost) {}

  private get deps(): FlowDeps {
    return this.host.deps;
  }

  preview(doc: Parameters<FlowDeps["review"]["catchUpPreview"]>[0]): Promise<CatchUpPreview | null> {
    return this.deps.review.catchUpPreview(doc);
  }

  async settleFromMain(row: ChangeRow, options: CatchUpAsked = {}): Promise<boolean> {
    const preview = await this.preview(row.doc);
    return preview?.kind === "behind" ? this.catchUp(row, preview, options) : this.catchUpWithMain(row);
  }

  async catchUpWithMain(row: ChangeRow): Promise<boolean> {
    const doing = { words: CATCH_UP_HERE.busy, paths: [row.change.path] };
    if (row.entry === null) return this.host.busy(() => this.catchUpVault(row), doing);
    return this.host.busy(async () => {
      const sent = await this.host.send(row, { afresh: true });
      if ("held" in sent) return false;
      if (!sent.ok) {
        await this.deps.dialogs.alert({ title: CATCH_UP_HERE.failed, description: sent.message });
        return false;
      }
      const said = sent.inVault === false ? CATCH_UP_HERE.doneInReview : CATCH_UP_HERE.done;
      this.deps.dialogs.toast(said.title, said.description);
      return true;
    }, doing);
  }

  private async catchUpVault(row: ChangeRow): Promise<boolean> {
    const mine = await this.deps.readText(row.change.path);
    const main = await this.deps.gitFile(row.doc);
    if (mine === null || main.kind !== "file") {
      await this.host.alert({ title: CATCH_UP_HERE.failed, description: main.kind === "absent" ? `${noteName(row.change.path)} is no longer on GitHub, so there is nothing to catch up with.` : UNREADABLE(noteName(row.change.path)) });
      return false;
    }
    const merged = await mergedWith(this.deps, row, mine, main.text);
    if (merged === null) return false;
    if (!(await this.host.memory.writeAndRemember(row.change.path, mine, merged, null, main.sha))) {
      this.deps.dialogs.toast(CATCH_UP_HERE.leftAsWas.title, CATCH_UP_HERE.leftAsWas.description);
      return false;
    }
    this.deps.dialogs.toast(CATCH_UP_HERE.done.title, CATCH_UP_HERE.done.description);
    return true;
  }

  async conflictPlaces(row: ChangeRow, preview: Behind): Promise<number | null> {
    const ours = (await this.deps.review.status(row.doc))?.reviewBranch;
    const seen = ours ? await this.deps.review.mergePreview(row.doc, ours, preview.base) : null;
    const mine = await this.deps.readText(row.change.path);
    if (!seen || !seen.ok || mine === null) return null;
    const body = seen.body as { baseSource: string; theirsSource: string };
    return mergeFile(row.change.path, toLf(body.baseSource), toLf(mine), toLf(body.theirsSource), this.deps.budget?.() ?? new Budget(400)).conflicts;
  }

  async catchUp(row: ChangeRow, preview: Behind, options: CatchUpAsked = {}): Promise<boolean> {
    if (preview.submitted && !options.asked && !(await this.deps.dialogs.confirm({ title: CATCH_UP.confirm.title, description: CATCH_UP.confirm.description, confirmLabel: CATCH_UP.confirm.confirmLabel }))) return false;
    return this.host.busy(async () => {
      const sent = await this.host.send(row, { toReview: true, afresh: true });
      if ("held" in sent) return false;
      if (!sent.ok) {
        await this.host.alert({ title: CATCH_UP_HERE.failed, description: sent.message });
        return false;
      }
      const mine = (await this.deps.readText(row.change.path)) ?? "";
      const merged = preview.merge === "clean" ? await this.commitClean(row, preview) : await this.commitChosen(row, preview, mine);
      if (merged === null) return false;
      const took = await this.host.memory.writeAndRemember(row.change.path, mine, merged.text, merged.text, preview.mainBlob);
      const said = took ? CATCH_UP_HERE.done : CATCH_UP_HERE.doneInReview;
      this.deps.dialogs.toast(said.title, [merged.summary, said.description].filter(Boolean).join(" "));
      return true;
    }, { words: CATCH_UP_HERE.busy, paths: [row.change.path] });
  }

  private async commitClean(row: ChangeRow, preview: Behind): Promise<{ text: string; summary: string } | null> {
    const done = await this.deps.review.catchUp(row.doc, preview.mainBlob);
    const result = done.ok ? (done.body.result as { kind?: string; source?: string; changes?: { summary: string } } | undefined) : undefined;
    if (!done.ok || !result || result.kind !== "caught_up" || result.source === undefined) {
      await this.host.alert({ title: result?.kind === "main_moved" ? CATCH_UP.toastMoved.title : CATCH_UP_HERE.failed, description: result?.kind === "main_moved" ? CATCH_UP.toastMoved.description : done.ok ? CATCH_UP.failedBody : failure(done, CATCH_UP.failedBody) });
      return null;
    }
    return { text: result.source, summary: result.changes?.summary ?? "" };
  }

  private async commitChosen(row: ChangeRow, preview: Behind, mine: string): Promise<{ text: string; summary: string } | null> {
    const review = await this.deps.review.status(row.doc);
    const ours = review?.reviewBranch;
    const seen = ours ? await this.deps.review.mergePreview(row.doc, ours, preview.base) : null;
    if (!ours || !seen || !seen.ok) {
      await this.host.alert({ title: CATCH_UP_HERE.failed, description: seen && !seen.ok ? failure(seen, CATCH_UP.failedBody) : CATCH_UP.failedBody });
      return null;
    }
    const body = seen.body as { baseSource: string; theirsSource: string; oursTipSha: string; theirsTipSha: string };
    const merged = mergeFile(row.change.path, toLf(body.baseSource), toLf(mine), toLf(body.theirsSource), this.deps.budget?.() ?? new Budget(400));
    const chosen = await this.deps.chooseWhatToKeep(buildReviewRequest(row.change.path, merged.review, { other: "github", signal: new AbortController().signal }));
    if (chosen === null) return null;
    const resolved = await this.deps.review.resolveMerge(row.doc, { ours, theirs: preview.base, oursTipSha: body.oursTipSha, theirsTipSha: body.theirsTipSha, resolvedSource: chosen });
    if (!resolved.ok) {
      await this.host.alert({ title: CATCH_UP_HERE.failed, description: failure(resolved, CATCH_UP.failedBody) });
      return null;
    }
    return { text: chosen, summary: "" };
  }
}
