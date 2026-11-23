import { retryAfterFromResponse } from "../api/retry-after";
import { safeRealtimeUrl } from "../links";
import type { DocumentRef } from "../mapping";
import type { AskedStep, RoomSteps, RoomToken, TokenSource } from "../token-source";
import { type Bearer, withBearer } from "./bearer";
import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer, PLUGIN_OUTDATED_CODE, VERSION_HEADER } from "./config";
import { DELETED_WORDS, DOCUMENT_DELETED_CODE } from "../deleted-words";
import { AuthError, NETWORK_MESSAGE, ROOM_ENDED_MESSAGE, SIGNED_OUT_MESSAGE } from "./errors";
import { jsonObject, type Transport } from "./transport";

export interface TokenSourceOptions {
  server: string;
  version: string;
  auth: Bearer;
  transport: Transport;
  pendingSteps?: (doc: DocumentRef) => readonly AskedStep[];
}

const MOST_STEPS = 16;

export class RoomTokenError extends AuthError {
  constructor(
    code: AuthError["code"],
    message: string,
    status: number,
    readonly reason: string | null,
    readonly deletedAt?: number,
    readonly retryAfterMs?: number,
  ) {
    super(code, message, status);
    this.name = "RoomTokenError";
  }
}

const ROOM_ENDED = "room_ended";

const OLD_SERVER_WAIT_S = 60;

const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");

function stepsOf(value: unknown): RoomSteps["said"] {
  if (typeof value !== "object" || value === null) return null;
  const { before, after } = value as Record<string, unknown>;
  return isIds(before) && isIds(after) ? { before, after } : null;
}

interface Answer {
  status: number;
  body: Record<string, unknown> | null;
  reason: string | null;
  message: string | null;
  retryAfterMs?: number;
}

export class SpecgitTokenSource implements TokenSource {
  private readonly server: string;
  private readonly joinedAt = new Map<string, number>();

  constructor(private readonly options: TokenSourceOptions) {
    this.server = normalizeServer(options.server);
  }

  private static keyOf(doc: DocumentRef): string {
    return `${doc.repo.toLowerCase()}\n${doc.path}`;
  }

  async roomToken(doc: DocumentRef, options: { session?: string | null } = {}): Promise<RoomToken> {
    const [owner, repo, ...rest] = doc.repo.split("/");
    if (!owner || !repo || rest.length > 0) throw new RoomTokenError("unexpected", `"${doc.repo}" isn't a repository name like owner/name.`, 0, null);
    const key = SpecgitTokenSource.keyOf(doc);

    const joinedAt = this.joinedAt.get(key);
    const asked = (this.options.pendingSteps?.(doc) ?? []).slice(-MOST_STEPS).map(({ id, sent }) => ({ id, sent }));
    const session = joinedAt !== undefined && asked.length > 0 && options.session ? { session: options.session } : {};
    const body = { provider: GIT_PROVIDER, owner, repo, branch: NOTE_BRANCH, path: doc.path, ...(joinedAt === undefined ? {} : { joinedAt }), ...(asked.length === 0 ? {} : { steps: asked.map((step) => step.id) }), ...session };
    const answer = await withBearer(this.options.auth, (token) => this.ask(token, body));
    if (answer.status !== 200) throw this.failure(answer);
    return this.joined(key, answer.body, asked);
  }

  async askForBridge(doc: DocumentRef, options: { session?: string | null } = {}): Promise<{ steps?: RoomSteps; bridgeWaitSeconds?: number }> {
    const [owner, repo, ...rest] = doc.repo.split("/");
    if (!owner || !repo || rest.length > 0) throw new RoomTokenError("unexpected", `"${doc.repo}" isn't a repository name like owner/name.`, 0, null);
    const key = SpecgitTokenSource.keyOf(doc);
    const joinedAt = this.joinedAt.get(key);
    const asked = (this.options.pendingSteps?.(doc) ?? []).slice(-MOST_STEPS).map(({ id, sent }) => ({ id, sent }));
    const body = { provider: GIT_PROVIDER, owner, repo, branch: NOTE_BRANCH, path: doc.path, ...(joinedAt === undefined ? {} : { joinedAt }), ...(asked.length === 0 ? {} : { steps: asked.map((step) => step.id) }), ...(joinedAt !== undefined && asked.length > 0 && options.session ? { session: options.session } : {}), bridgeAsk: true };
    const answer = await withBearer(this.options.auth, (token) => this.ask(token, body));
    if (answer.status !== 200) throw this.failure(answer);
    const said = answer.body?.bridge;
    const waitS = typeof said === "object" && said !== null ? (said as { waitSeconds?: unknown }).waitSeconds : undefined;
    const old = typeof answer.body?.token === "string";
    const seconds = typeof waitS === "number" && waitS > 0 ? waitS : 0;
    const wait = old ? Math.max(seconds, OLD_SERVER_WAIT_S) : seconds;
    const failed = answer.body !== null && "steps" in answer.body && answer.body.steps === null;
    return { ...(asked.length === 0 ? {} : { steps: { asked, said: stepsOf(answer.body?.steps), ...(failed ? { failed: true as const } : {}) } }), ...(wait > 0 ? { bridgeWaitSeconds: wait } : {}) };
  }

  leave(doc: DocumentRef): void {
    this.joinedAt.delete(SpecgitTokenSource.keyOf(doc));
  }

  private async ask(token: string, body: Record<string, unknown>): Promise<Answer> {
    let response;
    try {
      response = await this.options.transport({
        url: `${this.server}/api/realtime/token`,
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version },
        body: JSON.stringify(body),
      });
    } catch {
      throw new RoomTokenError("network", NETWORK_MESSAGE, 0, null);
    }
    const parsed = jsonObject(response.text);
    const error = typeof parsed?.error === "object" && parsed.error !== null ? (parsed.error as Record<string, unknown>) : null;
    const reason = typeof error?.code === "string" ? error.code : typeof parsed?.code === "string" ? parsed.code : null;
    const retryAfterMs = response.status === 429 || reason === "rate_limited" ? retryAfterFromResponse(response.headers, parsed) : undefined;
    return {
      status: response.status,
      body: parsed,
      reason,
      message: typeof error?.message === "string" ? error.message : null,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  private joined(key: string, body: Record<string, unknown> | null, asked: readonly AskedStep[]): RoomToken {
    const { url, room, token, readOnly, joinedAt, steps } = body ?? {};
    if (typeof url !== "string" || typeof room !== "string" || typeof token !== "string") {
      throw new RoomTokenError("unexpected", "This version of specgit is out of date. Update it in Community plugins.", 200, null);
    }
    const safeUrl = safeRealtimeUrl(url, this.server);
    if (safeUrl === null) {
      throw new RoomTokenError("unexpected", "specgit couldn't connect that note live just now.", 200, null);
    }
    if (typeof joinedAt === "number") this.joinedAt.set(key, joinedAt);
    const failed = body !== null && "steps" in body && steps === null;
    return { url: safeUrl, room, token, ...(readOnly === true ? { readOnly: true } : {}), ...(asked.length === 0 ? {} : { steps: { asked, said: stepsOf(steps), ...(failed ? { failed: true as const } : {}) } }) };
  }

  private failure(answer: Answer): RoomTokenError {
    if (answer.reason === PLUGIN_OUTDATED_CODE) {
      return new RoomTokenError("plugin_outdated", answer.message ?? "This version of specgit is out of date. Update it in Community plugins.", answer.status, answer.reason);
    }
    if (answer.reason === DOCUMENT_DELETED_CODE) {
      const at = answer.body?.deletedAt;
      return new RoomTokenError("document_deleted", DELETED_WORDS.title, answer.status, answer.reason, typeof at === "number" && Number.isFinite(at) ? at : undefined);
    }
    if (answer.reason === ROOM_ENDED) return new RoomTokenError("room_ended", ROOM_ENDED_MESSAGE, answer.status, answer.reason);
    if (answer.status === 401) return new RoomTokenError("signed_out", SIGNED_OUT_MESSAGE, 401, answer.reason);
    if (answer.status >= 500 || answer.status === 429 || answer.reason === "rate_limited") return new RoomTokenError("network", answer.message ?? NETWORK_MESSAGE, answer.status, answer.reason, undefined, answer.retryAfterMs);
    return new RoomTokenError("unexpected", answer.message ?? "specgit couldn't connect that note live just now.", answer.status, answer.reason);
  }
}
