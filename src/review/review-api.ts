import type { BurstFile, CatchUpPreview, GroupAction, GroupOverview, InFlightMap, PrInfo, PublishQuota, SavesTo } from "../shared/review-flow";
import { factsFromDetail, type ReviewFacts } from "../shared/status-panel";
import { type ApiAnswer, docParams, splitRepo, type SpecgitApi } from "../api";
import { GIT_PROVIDER, NOTE_BRANCH } from "../auth/config";
import { NETWORK_MESSAGE } from "../auth/errors";
import { TRY_AGAIN } from "../shared/review-flow";
import { DOCUMENT_DELETED_CODE } from "../deleted-words";
import type { DocumentRef } from "../mapping";

export type StepResult<Body = Record<string, unknown>> = { ok: true; body: Body } | { ok: false; status: number; code: string | null; message: string; body: Record<string, unknown> | null };

export interface ReviewStatus {
  reviewBranch: string | null;
  pr: PrInfo | null;
}

export interface DetailReviewer {
  login: string;
  avatarUrl: string | null;
  state: "requested" | "approved" | "changes_requested";
}

export type PrDetail = PrInfo & { reviewers: DetailReviewer[]; behind: boolean };

const DECISIONS: readonly string[] = ["approved", "changes_requested", "review_required"];
const REVIEWER_STATES: readonly string[] = ["requested", "approved", "changes_requested"];

function parseDetail(one: PrInfo & { reviewers?: unknown; behind?: unknown }): PrDetail {
  const { reviewers, behind, reviewPolicy, ...rest } = one;
  const people: DetailReviewer[] = Array.isArray(reviewers)
    ? reviewers.flatMap((person: unknown) => {
        const { login, avatarUrl, state } = (person ?? {}) as { login?: unknown; avatarUrl?: unknown; state?: unknown };
        return typeof login === "string" && login !== "" && typeof state === "string" && REVIEWER_STATES.includes(state)
          ? [{ login, avatarUrl: typeof avatarUrl === "string" && avatarUrl !== "" ? avatarUrl : null, state: state as DetailReviewer["state"] }]
          : [];
      })
    : [];
  const policy = reviewPolicy as Partial<NonNullable<PrInfo["reviewPolicy"]>> | null | undefined;
  const kept = typeof policy === "object" && policy !== null && typeof policy.approvals === "number" ? { reviewPolicy: { reviewDecision: typeof policy.reviewDecision === "string" && DECISIONS.includes(policy.reviewDecision) ? policy.reviewDecision : null, approvals: policy.approvals, requiredApprovals: typeof policy.requiredApprovals === "number" ? policy.requiredApprovals : null, requiresCodeOwnerReview: policy.requiresCodeOwnerReview === true } } : {};
  return { ...rest, ...kept, reviewers: people, behind: behind === true };
}

export const factsOf = (detail: PrDetail): ReviewFacts => factsFromDetail(detail);

export const reviewIsOpen = (status: ReviewStatus): boolean => {
  const state = status.pr?.state;
  return state !== "merged" && state !== "closed" && (status.reviewBranch !== null || status.pr !== null);
};

export type GroupsRead = ({ kind: "groups";  overviews: Record<string, GroupOverview>; base: string; locked: boolean } | { kind: "off" } | { kind: "unknown" }) & {
  paths?: InFlightMap;
  stale?: true;
  asOf?: number;
  saves?: SavesTo;
  canPush?: boolean;
  publishQuota?: PublishQuota;
};

export type PresenceRead = { kind: "docs"; docs: ReadonlyArray<{ path: string; people: readonly string[]; agents: number }> } | { kind: "off" } | { kind: "unknown" };

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");
const isOverview = (value: unknown): value is GroupOverview => {
  const group = value as Partial<GroupOverview> | null;
  return typeof group === "object" && group !== null && typeof group.id === "string" && typeof group.name === "string" && typeof group.prNumber === "number" && strings(group.paths) && strings(group.holdPaths);
};
export const isLostAnswerResult = (result: StepResult): boolean => !result.ok && result.status === 0 && result.code === "network";

export const MAIN_MOVED = "main_moved";
export const ROOM_BEHIND = "room_behind";
export const deletedAtOf = (result: StepResult): number | null => {
  if (result.ok || result.status !== 410 || result.code !== DOCUMENT_DELETED_CODE) return null;
  const at = result.body?.deletedAt ?? (typeof result.body?.error === "object" && result.body.error !== null ? (result.body.error as { deletedAt?: unknown }).deletedAt : undefined);
  return typeof at === "number" && Number.isFinite(at) ? at : Date.now();
};

const claim = (expectMain: string | null | undefined): Record<string, unknown> => (expectMain === undefined ? {} : { expectMain });

const GITHUB_DID_NOT_ACCEPT_REVIEW = "GitHub didn't accept this review.";

const failed = (answer: ApiAnswer, fallback: string): StepResult<never> => ({ ok: false, status: answer.status, code: answer.code, message: answer.message ?? fallback, body: answer.body });

export interface Reviewer {
  login: string;
  avatarUrl: string | null;
}

export class ReviewApi {
  constructor(private readonly api: SpecgitApi) {}

  private send(path: string, doc: DocumentRef, extra: Record<string, unknown> = {}, fallback = TRY_AGAIN): Promise<StepResult> {
    const params = docParams(doc);
    return this.sendRaw(path, params && { ...params, ...extra }, fallback);
  }

  async details(repo: string, numbers: readonly number[]): Promise<Map<number, PrDetail> | null | "failed"> {
    const named = splitRepo(repo);
    if (!named || numbers.length === 0) return new Map();
    try {
      const answer = await this.api.call("POST", "/api/docs/pr/details", { body: { provider: GIT_PROVIDER, owner: named.owner, repo: named.repo, numbers } });
      if (answer.status === 404 || answer.status === 405 || answer.status === 501) return null;
      const prs = answer.status === 200 ? answer.body?.prs : undefined;
      if (!Array.isArray(prs)) return "failed";
      return new Map(prs.flatMap((one: unknown) => (typeof one === "object" && one !== null && typeof (one as PrInfo).number === "number" ? [[(one as PrInfo).number, parseDetail(one as PrInfo)] as const] : [])));
    } catch {
      return "failed";
    }
  }

  async status(doc: DocumentRef): Promise<ReviewStatus | null> {
    const params = docParams(doc);
    if (!params) return null;
    try {
      const answer = await this.api.call("GET", "/api/docs/pr", { query: params });
      if (answer.status !== 200 || !answer.body) return null;
      const reviewBranch = typeof answer.body.reviewBranch === "string" ? answer.body.reviewBranch : null;
      return { reviewBranch, pr: (answer.body.pr as PrInfo | null | undefined) ?? null };
    } catch {
      return null;
    }
  }

  async groups(repo: string): Promise<GroupsRead> {
    const named = splitRepo(repo);
    if (!named) return { kind: "unknown" };
    try {
      const answer = await this.api.call("GET", `/api/repos/${GIT_PROVIDER}/${named.owner}/${named.repo}/in-flight`, { query: { branch: NOTE_BRANCH } });
      if (answer.status !== 200 || !answer.body) return { kind: "unknown" };
      const groups = answer.body.groups;
      const found = answer.body.paths;
      const paths = typeof found === "object" && found !== null && !Array.isArray(found) ? { paths: found as InFlightMap } : {};
      const said = answer.body.saves;
      const saves: { saves?: SavesTo } = said === "shared" || said === "own" ? { saves: said } : {};
      const quota = answer.body.publishQuota as { limit?: unknown; used?: unknown } | undefined;
      const known: { canPush?: boolean; publishQuota?: PublishQuota } = {
        ...(typeof answer.body.canPush === "boolean" ? { canPush: answer.body.canPush } : {}),
        ...(quota && (quota.limit === null || typeof quota.limit === "number") && typeof quota.used === "number" ? { publishQuota: { limit: quota.limit, used: quota.used } } : {}),
      };
      const age = answer.body.ageMs;
      const asOf = typeof age === "number" && Number.isFinite(age) && age >= 0 ? { asOf: Date.now() - age } : {};
      const rest = { ...paths, ...saves, ...known, ...asOf, ...(answer.body.stale === true ? { stale: true as const } : {}) };
      if (groups === undefined) return { kind: "off", ...rest };
      if (typeof groups !== "object" || groups === null) return { kind: "unknown" };
      const overviews = Object.fromEntries(Object.entries(groups).filter(([, one]) => isOverview(one))) as Record<string, GroupOverview>;
      return { kind: "groups", overviews, base: typeof answer.body.base === "string" ? answer.body.base : NOTE_BRANCH, locked: answer.body.groupsLocked === true, ...rest };
    } catch {
      return { kind: "unknown" };
    }
  }

  async presence(repo: string): Promise<PresenceRead> {
    const named = splitRepo(repo);
    if (!named) return { kind: "docs", docs: [] };
    try {
      const answer = await this.api.call("GET", `/api/repos/${GIT_PROVIDER}/${named.owner}/${named.repo}/presence`);
      if (answer.status === 404) return { kind: "off" };
      const found = answer.status === 200 ? answer.body?.docs : undefined;
      if (!Array.isArray(found)) return { kind: "unknown" };
      const docs = found.flatMap((one: unknown) => {
        const doc = one as { path?: unknown; people?: unknown; agents?: unknown } | null;
        if (typeof doc !== "object" || doc === null || typeof doc.path !== "string") return [];
        const people = Array.isArray(doc.people) ? doc.people.flatMap((person: unknown) => (typeof person === "object" && person !== null && typeof (person as { login?: unknown }).login === "string" ? [(person as { login: string }).login] : [])) : [];
        const agents = typeof doc.agents === "number" && Number.isFinite(doc.agents) && doc.agents > 0 ? Math.floor(doc.agents) : 0;
        return [{ path: doc.path, people, agents }];
      });
      return { kind: "docs", docs };
    } catch {
      return { kind: "unknown" };
    }
  }

  group(repo: string, action: GroupAction, body: { id?: string; paths?: readonly string[]; name?: string; resolve?: "mine" | "theirs";  unsent?: readonly { path: string; sha: string }[]; dryRun?: boolean; upload?: { uploadId: string; last: boolean; files: readonly BurstFile[]; attachments?: readonly { filePath: string; sha: string; size: number; base64?: string }[] } }): Promise<StepResult> {
    const named = splitRepo(repo);
    return this.sendRaw("/api/docs/group", named && { provider: GIT_PROVIDER, ...named, branch: NOTE_BRANCH, action, ...body });
  }

  save(doc: DocumentRef, source: string, expectMain?: string | null, options: {  attachments?: readonly { filePath: string; sha: string; size: number; base64?: string; expectSha?: string | null }[];  attachmentsKeepGoing?: true; toExistingReview?: boolean;  afresh?: boolean; expectBranch?: string;  hasReview?: boolean;  createOver?: number } = {}): Promise<StepResult> {
    return this.send("/api/docs/save", doc, { source, ...claim(expectMain), ...(options.toExistingReview ? { toExistingReview: true } : {}), ...(options.afresh ? { afresh: true } : {}), ...(options.expectBranch === undefined ? {} : { expectBranch: options.expectBranch }), ...(options.attachments && options.attachments.length > 0 ? { attachments: options.attachments } : {}), ...(options.attachmentsKeepGoing ? { attachmentsKeepGoing: true } : {}), ...(options.createOver === undefined ? {} : { createOver: options.createOver }) });
  }

  share(doc: DocumentRef): Promise<StepResult> {
    return this.send("/api/docs/share", doc);
  }

  requestReview(doc: DocumentRef, reviewers: readonly string[]): Promise<StepResult> {
    return this.send("/api/docs/request-review", doc, { reviewers });
  }

  unsubmit(doc: DocumentRef): Promise<StepResult> {
    return this.send("/api/docs/unsubmit", doc);
  }

  publish(doc: DocumentRef, whenApproved = false, expectMain?: string | null): Promise<StepResult> {
    return this.send("/api/docs/publish", doc, { strategy: "squash", whenApproved, ...claim(expectMain) });
  }

  review(doc: DocumentRef, verdict: "approve" | "request_changes", note?: string): Promise<StepResult> {
    return this.send("/api/docs/review", doc, { verdict, ...(note === undefined ? {} : { note }) }, GITHUB_DID_NOT_ACCEPT_REVIEW);
  }

  abandon(doc: DocumentRef, step?: string, expectPr?: number): Promise<StepResult> {
    return this.send("/api/docs/abandon", doc, { ...(step === undefined ? {} : { step }), ...(expectPr === undefined ? {} : { expectPr }) });
  }

  rename(doc: DocumentRef, to: string, expectMain?: string | null): Promise<StepResult> {
    return this.send("/api/docs/rename", doc, { newPath: to, ...claim(expectMain) });
  }

  remove(doc: DocumentRef, expectMain?: string | null): Promise<StepResult> {
    return this.send("/api/docs/delete", doc, claim(expectMain));
  }

  moves(repo: string, set: { moves: readonly { path: string; newPath: string; expectMain: string | null }[]; deletes: readonly { path: string; expectMain: string | null }[] }): Promise<StepResult> {
    const named = splitRepo(repo);
    return this.sendRaw("/api/docs/moves", named && { provider: GIT_PROVIDER, ...named, branch: NOTE_BRANCH, ...set });
  }

  movesKnown(repo: string, set: { moves: readonly { path: string; newPath: string; expectMain: string | null }[] }): Promise<StepResult> {
    const named = splitRepo(repo);
    return this.sendRaw("/api/docs/moves/known", named && { provider: GIT_PROVIDER, ...named, branch: NOTE_BRANCH, path: set.moves[0]?.path });
  }

  attachment(note: DocumentRef, filePath: string, base64: string, expectSha?: string | null): Promise<StepResult> {
    return this.send("/api/docs/attachment", note, { filePath, base64, ...(expectSha === undefined ? {} : { expectSha }) });
  }

  async reviewers(doc: DocumentRef): Promise<Reviewer[]> {
    const params = docParams(doc);
    if (!params) return [];
    try {
      const answer = await this.api.call("GET", "/api/docs/reviewers", { query: params });
      const list = answer.status === 200 ? answer.body?.reviewers : undefined;
      return Array.isArray(list)
        ? list.flatMap((one: unknown) => {
            const { login, avatarUrl } = (one ?? {}) as { login?: unknown; avatarUrl?: unknown };
            return typeof login === "string" ? [{ login, avatarUrl: typeof avatarUrl === "string" && avatarUrl !== "" ? avatarUrl : null }] : [];
          })
        : [];
    } catch {
      return [];
    }
  }

  async catchUpPreview(doc: DocumentRef): Promise<CatchUpPreview | null> {
    const params = docParams(doc);
    if (!params) return null;
    try {
      const answer = await this.api.call("GET", "/api/docs/catch-up", { query: params });
      return answer.status === 200 && answer.body?.preview ? (answer.body.preview as CatchUpPreview) : null;
    } catch {
      return null;
    }
  }

  catchUp(doc: DocumentRef, expectMain: string): Promise<StepResult> {
    return this.send("/api/docs/catch-up", doc, { expectMain });
  }

  mergePreview(doc: DocumentRef, ours: string, theirs: string, holds?: string): Promise<StepResult> {
    const params = docParams(doc);
    return this.sendRaw("/api/docs/merge-preview", params && { provider: params.provider, owner: params.owner, repo: params.repo, path: params.path, ours, theirs, ...(holds === undefined ? {} : { holds }) });
  }

  resolveMerge(doc: DocumentRef, input: { ours: string; theirs: string; oursTipSha: string; theirsTipSha: string; resolvedSource: string }): Promise<StepResult> {
    const params = docParams(doc);
    return this.sendRaw("/api/docs/resolve-merge", params && { provider: params.provider, owner: params.owner, repo: params.repo, path: params.path, ...input, commitMode: "merge" });
  }

  private async sendRaw(path: string, body: Record<string, unknown> | null, fallback = TRY_AGAIN): Promise<StepResult> {
    if (!body) return { ok: false, status: 0, code: null, message: fallback, body: null };
    try {
      const answer = await this.api.call("POST", path, { body });
      const answered = answer.status >= 200 && answer.status < 300;
      if (answered && !answer.body) return { ok: false, status: 0, code: "network", message: NETWORK_MESSAGE, body: null };
      return answered && answer.body ? { ok: true, body: answer.body } : failed(answer, fallback);
    } catch {
      return { ok: false, status: 0, code: "network", message: NETWORK_MESSAGE, body: null };
    }
  }
}
