import { type Bearer, withBearer } from "../auth/bearer";
import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer, VERSION_HEADER } from "../auth/config";
import { NETWORK_MESSAGE, SIGNED_OUT_MESSAGE } from "../auth/errors";
import { jsonObject, type Transport } from "../auth/transport";
import type { DocumentRef } from "../mapping";
import { COMMENT_WORDS, type AnchoredThreadView, type NewThread, type PrInfo, type ReviewStart, type ThreadComment, type ThreadListing, type ThreadsIo, type WriteAnswer } from "../shared/review-flow";

export interface CommentsApiOptions {
  server: string;
  version: string;
  auth: Bearer;
  transport: Transport;
}

export class CommentsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "CommentsError";
  }
}

export function isReviewNotOpen(error: unknown): boolean {
  return error instanceof CommentsError && error.status === 409 && error.code === "conflict";
}

export interface CommentsPort {
  io(doc: DocumentRef, opener: { run<T>(write: () => Promise<T>, onPr?: (pr: PrInfo) => void): Promise<T> }): ThreadsIo;
  startReview(doc: DocumentRef): Promise<ReviewStart<PrInfo>>;
  savedSource(doc: DocumentRef): Promise<string>;
}

export class CommentsApi implements CommentsPort {
  private readonly server: string;

  constructor(private readonly options: CommentsApiOptions) {
    this.server = normalizeServer(options.server);
  }

  private fields(doc: DocumentRef): Record<string, string> | null {
    const [owner, repo, ...rest] = doc.repo.split("/");
    if (!owner || !repo || rest.length > 0) return null;
    return { provider: GIT_PROVIDER, owner, repo, branch: NOTE_BRANCH, path: doc.path };
  }

  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown }, fallback: string): Promise<Record<string, unknown>> {
    let response;
    try {
      response = await withBearer(this.options.auth, (token) =>
        this.options.transport({
          url: `${this.server}${path}`,
          method: init.method,
          headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version },
          ...(init.body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(init.body) }),
        }),
      );
    } catch {
      throw new CommentsError(NETWORK_MESSAGE, 0, null);
    }
    const body = jsonObject(response.text);
    if (response.status >= 200 && response.status < 300) return body ?? {};
    const error = typeof body?.error === "object" && body.error !== null ? (body.error as Record<string, unknown>) : null;
    const message = typeof error?.message === "string" ? error.message : null;
    const code = typeof error?.code === "string" ? error.code : null;
    throw new CommentsError(response.status === 401 ? SIGNED_OUT_MESSAGE : (message ?? fallback), response.status, code);
  }

  private async docCall(doc: DocumentRef, path: string, init: { method: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string> }, fallback: string) {
    const fields = this.fields(doc);
    if (!fields) throw new CommentsError(`"${doc.repo}" isn't a repository name like owner/name.`, 0, null);
    if (init.method === "POST") return this.call(path, { method: "POST", body: { ...fields, ...init.body } }, fallback);
    return this.call(`${path}?${new URLSearchParams({ ...fields, ...init.query }).toString()}`, { method: "GET" }, fallback);
  }

  async list(doc: DocumentRef, history: boolean): Promise<ThreadListing> {
    return this.docCall(doc, "/api/docs/threads", { method: "GET", query: history ? { history: "1" } : {} }, COMMENT_WORDS.loadFailed);
  }

  async create(doc: DocumentRef, input: NewThread): Promise<AnchoredThreadView> {
    const body = await this.docCall(
      doc,
      "/api/docs/threads",
      { method: "POST", body: { lineStart: input.lineStart, lineEnd: input.lineEnd, body: input.body, exactText: input.quotedText } },
      COMMENT_WORDS.saveFailed,
    );
    return body.thread as AnchoredThreadView;
  }

  async write(doc: DocumentRef, threadId: string, action: string, extra: Record<string, unknown>, prNumber: number | undefined): Promise<WriteAnswer> {
    const body = await this.docCall(
      doc,
      `/api/docs/threads/${encodeURIComponent(threadId)}/${action}`,
      { method: "POST", body: { ...extra, ...(prNumber ? { prNumber } : {}) } },
      COMMENT_WORDS.saveFailed,
    );
    const isObject = (value: unknown): boolean => typeof value === "object" && value !== null;
    return {
      ...(isObject(body.thread) ? { thread: body.thread as AnchoredThreadView } : {}),
      ...(isObject(body.comment) ? { comment: body.comment as ThreadComment } : {}),
    };
  }

  async startReview(doc: DocumentRef): Promise<ReviewStart<PrInfo>> {
    try {
      const body = await this.docCall(doc, "/api/docs/start-revision", { method: "POST", body: {} }, COMMENT_WORDS.needsReview);
      return { ok: true, pr: body.pr as PrInfo | undefined };
    } catch (error) {
      return { ok: false, message: error instanceof CommentsError ? error.message : null };
    }
  }

  async savedSource(doc: DocumentRef): Promise<string> {
    const body = await this.docCall(doc, "/api/docs/content", { method: "GET", query: { followReview: "1" } }, COMMENT_WORDS.loadFailed);
    return body.exists === true && typeof body.source === "string" ? body.source : "";
  }

  io(doc: DocumentRef, opener: { run<T>(write: () => Promise<T>, onPr?: (pr: PrInfo) => void): Promise<T> }): ThreadsIo {
    return {
      list: (history) => this.list(doc, history),
      create: (input) => opener.run(() => this.create(doc, input)),
      write: (threadId, action, extra, prNumber) => opener.run(() => this.write(doc, threadId, action, extra, prNumber)),
    };
  }
}
