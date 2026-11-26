import { type Bearer, withBearer } from "./auth/bearer";
import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer, VERSION_HEADER } from "./auth/config";
import { headerOf, parseApiAnswer, type Transport } from "./auth/transport";
import { isFastFailResponse, retryAfterFromResponse } from "./api/retry-after";
import type { DocumentRef } from "./mapping";
import { GITHUB_UNAVAILABLE_CODE } from "./shared/review-flow";

const NON_GITHUB_PATHS = /^\/api\/(?:status\/github|support\/report)$|\/(?:events|presence)$/;

export interface ApiAnswer {
  status: number;
  body: Record<string, unknown> | null;
  message: string | null;
  code: string | null;
  retryAfterMs?: number;
  fastFail?: boolean;
  etag?: string;
  notModified?: boolean;
}

export interface ApiOptions {
  server: string;
  version: string;
  auth: Bearer;
  transport: Transport;
  onGithubFastFail?: (retryAfterMs: number | undefined) => void;
  onGithubHealthy?: () => void;
}

export function splitRepo(repo: string): { owner: string; repo: string } | null {
  const [owner, name, ...rest] = repo.split("/");
  return owner && name && rest.length === 0 ? { owner, repo: name } : null;
}

export function docParams(doc: DocumentRef): Record<string, string> | null {
  const named = splitRepo(doc.repo);
  return named ? { provider: GIT_PROVIDER, ...named, branch: NOTE_BRANCH, path: doc.path } : null;
}

export class SpecgitApi {
  private readonly server: string;
  onGithubFastFail?: (retryAfterMs: number | undefined) => void;
  onGithubHealthy?: () => void;

  constructor(private readonly options: ApiOptions) {
    this.server = normalizeServer(options.server);
    this.onGithubFastFail = options.onGithubFastFail;
    this.onGithubHealthy = options.onGithubHealthy;
  }

  async call(method: "GET" | "POST", path: string, input: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal; maxRetryAfterMs?: number; etag?: string } = {}): Promise<ApiAnswer> {
    const query = input.query ? `?${new URLSearchParams(input.query).toString()}` : "";
    const response = await withBearer(
      this.options.auth,
      (token) =>
        this.options.transport({
          url: `${this.server}${path}${query}`,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            [VERSION_HEADER]: this.options.version,
            ...(input.etag !== undefined && input.etag !== "" ? { "If-None-Match": input.etag } : {}),
          },
          ...(input.body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(input.body) }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      input.signal,
    );
    const answer = parseApiAnswer(response.status, response.text);
    const fastFail = isFastFailResponse(response.headers, answer.body);
    const githubUnavailable = answer.status === 503 || answer.code === GITHUB_UNAVAILABLE_CODE || fastFail;
    const retryAfterMs =
      answer.status === 429 || answer.code === "rate_limited" || githubUnavailable
        ? retryAfterFromResponse(response.headers, answer.body, Date.now(), input.maxRetryAfterMs)
        : undefined;
    if (fastFail || (answer.status === 503 && answer.code === GITHUB_UNAVAILABLE_CODE)) {
      this.onGithubFastFail?.(retryAfterMs);
    } else if (answer.status >= 200 && answer.status < 300 && !NON_GITHUB_PATHS.test(path) && answer.body?.stale !== true) {
      this.onGithubHealthy?.();
    }
    const etag = headerOf(response, "etag");
    const notModified = response.status === 304;
    return {
      ...answer,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(fastFail ? { fastFail: true } : {}),
      ...(etag === undefined ? {} : { etag }),
      notModified,
    };
  }
}
