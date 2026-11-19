import { type Bearer, withBearer } from "./auth/bearer";
import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer, VERSION_HEADER } from "./auth/config";
import { jsonObject, type Transport } from "./auth/transport";
import type { DocumentRef } from "./mapping";

export interface ApiAnswer {
  status: number;
  body: Record<string, unknown> | null;

  message: string | null;
  code: string | null;
}

export interface ApiOptions {
  server: string;
  version: string;
  auth: Bearer;
  transport: Transport;
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

  constructor(private readonly options: ApiOptions) {
    this.server = normalizeServer(options.server);
  }

  async call(method: "GET" | "POST", path: string, input: { query?: Record<string, string>; body?: unknown } = {}): Promise<ApiAnswer> {
    const query = input.query ? `?${new URLSearchParams(input.query).toString()}` : "";
    const response = await withBearer(this.options.auth, (token) =>
      this.options.transport({
        url: `${this.server}${path}${query}`,
        method,
        headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version },
        ...(input.body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(input.body) }),
      }),
    );
    const body = jsonObject(response.text);
    const error = body && typeof body.error === "object" && body.error !== null ? (body.error as Record<string, unknown>) : null;
    return {
      status: response.status,
      body,
      message: typeof error?.message === "string" ? error.message : null,

      code: typeof error?.code === "string" ? error.code : typeof body?.code === "string" ? body.code : null,
    };
  }
}
