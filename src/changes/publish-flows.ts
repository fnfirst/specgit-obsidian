import { noteName } from "../mapping";
import { MAIN_MOVED, type StepResult } from "../review/review-api";
import { AUTO_PUBLISH_HERE, PUBLISHED_HERE } from "../review/words";
import {
  ALREADY_PUBLISHED,
  AUTO_PUBLISH_DECLINED,
  AUTO_PUBLISH_FAILED,
  type BlockedPublish,
  COULD_NOT_PUBLISH,
  decideBlocked,
  type ItemOutcome,
  PUBLISH_FAILED,
  type PrInfo,
  STILL_CANT_PUBLISH,
  VIEW_ON_GITHUB,
} from "../shared/review-flow";
import type { Dialogs, FlowDeps } from "./flow-deps";
import { failure, MOVED_AGAIN, MOVED_ATTEMPTS, type Sent } from "./flow-helpers";
import type { ChangeRow } from "./model";

const GITHUB_DID_NOT_ACCEPT = "GitHub didn't accept it.";

type Refused = Extract<StepResult, { ok: false }>;

type Went =
  | { kind: "held" }
  | { kind: "unchanged" }
  | { kind: "done"; body: Record<string, unknown> }

  | { kind: "stopped" }
  | { kind: "failed"; message: string }

  | { kind: "refused"; result: Refused };

export interface PublishHost {
  readonly deps: FlowDeps;
  sendUnit(row: ChangeRow): Promise<Sent>;
  alert(options: Parameters<Dialogs["alert"]>[0]): Promise<void>;
  refusal(result: Refused, doc: ChangeRow["doc"], fallback: string): string;
}

export class PublishFlows {
  constructor(private readonly host: PublishHost) {}

  private get deps(): FlowDeps {
    return this.host.deps;
  }

  private async publishFile(row: ChangeRow, fallback: string, onRefused?: (result: Refused, expectMain: string | null) => Promise<Went | "moved">, inSet = false): Promise<Went> {
    for (let attempt = 1; attempt <= MOVED_ATTEMPTS; attempt++) {
      const sent = await this.host.sendUnit(row);
      if ("held" in sent) return { kind: "held" };
      if (!sent.ok) return { kind: "failed", message: sent.message };
      if (sent.unchanged && !row.group) return { kind: "unchanged" };

      if (sent.attachments) return { kind: "failed", message: `${sent.attachments} ${inSet ? "This note was not published." : "Nothing was published."}` };
      if (!row.entry || row.entry.isDraft) {
        const ready = await this.deps.review.share(row.doc);
        if (!ready.ok) return { kind: "failed", message: this.host.refusal(ready, row.doc, fallback) };
      }
      const result = await this.deps.review.publish(row.doc, false, sent.expectMain);
      if (result.ok) return { kind: "done", body: result.body };
      if (result.code === MAIN_MOVED) continue;
      const went = onRefused ? await onRefused(result, sent.expectMain) : ({ kind: "refused", result } as const);
      if (went !== "moved") return went;
    }
    return { kind: "failed", message: MOVED_AGAIN(noteName(row.change.path)) };
  }

  async single(row: ChangeRow): Promise<boolean | "unchanged"> {

    const went = await this.publishFile(row, COULD_NOT_PUBLISH, (result, expectMain) => this.decide(row, result, expectMain));
    switch (went.kind) {
      case "unchanged":
        return "unchanged";
      case "done":
        return this.published(went.body);
      case "failed":
        await this.host.alert({ title: PUBLISH_FAILED, description: went.message });
        return false;
      default:
        return false;
    }
  }

  async forSet(row: ChangeRow): Promise<ItemOutcome | "held" | "unchanged"> {
    const path = row.change.path;
    const went = await this.publishFile(row, GITHUB_DID_NOT_ACCEPT, undefined, true);
    switch (went.kind) {
      case "held":
      case "unchanged":
        return went.kind;
      case "done":
        return { path, status: "done" };
      case "refused": {
        const body = (went.result.body ?? {}) as BlockedPublish & { blocked?: boolean };
        const reason = body.reason ?? this.host.refusal(went.result, row.doc, GITHUB_DID_NOT_ACCEPT);
        return { path, status: body.blocked ? "waiting" : "failed", reason };
      }
      default:
        return { path, status: "failed", reason: went.kind === "failed" ? went.message : GITHUB_DID_NOT_ACCEPT };
    }
  }

  private published(body: Record<string, unknown>): true {
    const words = body.alreadyMerged === true ? ALREADY_PUBLISHED : PUBLISHED_HERE;
    this.deps.dialogs.toast(words.title, words.description);
    return true;
  }

  private async decide(row: ChangeRow, result: Refused, expectMain: string | null): Promise<Went | "moved"> {
    const body = (result.body ?? {}) as BlockedPublish & { blocked?: boolean };
    if (!body.blocked) {
      await this.host.alert({ title: PUBLISH_FAILED, description: this.host.refusal(result, row.doc, COULD_NOT_PUBLISH) });
      return { kind: "stopped" };
    }

    const decision = decideBlocked(body, false);
    if (decision.kind === "merge") {
      if (!(await this.deps.dialogs.confirm({ title: decision.title, description: decision.description, confirmLabel: decision.confirm }))) return { kind: "stopped" };
      const retry = await this.deps.review.publish(row.doc, false, expectMain);
      if (retry.ok) return { kind: "done", body: retry.body };
      if (retry.code === MAIN_MOVED) return "moved";
      const again = (retry.body ?? {}) as BlockedPublish;
      await this.host.alert({ title: STILL_CANT_PUBLISH, description: again.reason ?? failure(retry, COULD_NOT_PUBLISH), href: again.prUrl ?? null, hrefLabel: VIEW_ON_GITHUB });
      return { kind: "stopped" };
    }
    if (decision.kind === "arm") {
      const arm = await this.deps.dialogs.confirm({ title: decision.title, description: decision.description, confirmLabel: decision.confirm, cancelLabel: decision.cancel });
      if (arm) await this.armPublish(row, body.pr ?? null, expectMain);
      return { kind: "stopped" };
    }
    if (decision.kind === "alert") await this.host.alert({ title: decision.title, description: decision.description ?? undefined, href: decision.href, hrefLabel: decision.hrefLabel });
    return { kind: "stopped" };
  }

  private async armPublish(row: ChangeRow, pr: PrInfo | null, expectMain: string | null): Promise<void> {
    const result = await this.deps.review.publish(row.doc, true, expectMain);
    if (result.ok && result.body.autoPublish) return this.deps.dialogs.toast(AUTO_PUBLISH_HERE.title, AUTO_PUBLISH_HERE.description);
    if (result.ok) return this.deps.dialogs.toast(PUBLISHED_HERE.title, PUBLISHED_HERE.description);
    await this.host.alert({ title: AUTO_PUBLISH_FAILED, description: result.message || AUTO_PUBLISH_DECLINED, href: pr?.url ?? null, hrefLabel: VIEW_ON_GITHUB });
  }
}
