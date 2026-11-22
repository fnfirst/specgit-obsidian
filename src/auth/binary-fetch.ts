import { type ApiAnswer, splitRepo } from "../api";
import type { DocumentRef } from "../mapping";
import { MAX_ATTACHMENT_BYTES, TRY_AGAIN, type VaultPackMeta } from "../shared/review-flow";
import { type Bearer, withBearer } from "./bearer";
import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer, VERSION_HEADER } from "./config";
import { NETWORK_MESSAGE } from "./errors";
import type { AttachmentFile } from "./git-copy";
import { base64Url } from "./pkce";
import { decodeHeaderPath, parseApiAnswer, retryGet } from "./transport";

export type BinaryStepResult<Body = Record<string, unknown>> =
  | { ok: true; body: Body }
  | { ok: false; status: number; code: string | null; message: string; body: Record<string, unknown> | null };

export const BINARY_DEADLINE_MS = 300_000;

export type BinaryFetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface BinaryFetchOptions {
  server: string;
  version: string;
  auth: Bearer;
  fetchFn?: BinaryFetchFn;
  pause?: (ms: number) => Promise<void>;
  deadlineMs?: number;
}

export interface BinaryAttachmentUpload {
  note: DocumentRef;
  filePath: string;
  blobSha: string;
  body: Blob | Uint8Array;
  expectSha?: string | null;
  createOver?: number;
}

export function encodeMetaHeader(meta: Record<string, unknown>): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(meta)));
}

export function encodeVaultPackBody(meta: VaultPackMeta, blobs: readonly (Blob | Uint8Array)[]): Blob {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, metaBytes.byteLength, false);
  const parts: BlobPart[] = [header, metaBytes];
  for (const blob of blobs) {
    parts.push(
      ArrayBuffer.isView(blob)
        ? new Uint8Array(blob.buffer as ArrayBuffer, blob.byteOffset, blob.byteLength)
        : blob,
    );
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

export function formatIfNoneMatch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const unquoted = trimmed.replace(/^W\//i, "").replace(/^"+|"+$/g, "");
  return unquoted === "" ? undefined : `"${unquoted}"`;
}

export function parseEtagSha(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^W\//i, "").replace(/^"+|"+$/g, "");
  return /^[0-9a-f]{40}$/i.test(stripped) ? stripped.toLowerCase() : undefined;
}

const isAbortError = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

const cancelBody = async (res: Response): Promise<void> => {
  await res.body?.cancel().catch(() => undefined);
};

function deadlineGuardedStream(source: ReadableStream<Uint8Array>, controller: AbortController, clear: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let closed = false;
  let rejectAbort: ((err: Error) => void) | null = null;
  const abortError = (): Error => Object.assign(new Error("specgit didn't answer in time."), { name: "AbortError" });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  abortPromise.catch(() => undefined);

  const onAbort = (): void => {
    if (closed) return;
    closed = true;
    clear();
    const err = abortError();
    rejectAbort?.(err);
    void reader.cancel(err).catch(() => undefined);
  };
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener("abort", onAbort, { once: true });

  const cleanup = (): void => {
    closed = true;
    clear();
    controller.signal.removeEventListener("abort", onAbort);
  };
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      return;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      if (controller.signal.aborted) {
        cleanup();
        await reader.cancel(abortError()).catch(() => undefined);
        release();
        streamController.error(abortError());
        return;
      }
      try {
        const next = await Promise.race([reader.read(), abortPromise]);
        if (next.done) {
          cleanup();
          release();
          streamController.close();
          return;
        }
        streamController.enqueue(next.value);
      } catch (err) {
        cleanup();
        await reader.cancel(err).catch(() => undefined);
        release();
        streamController.error(err);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason).catch(() => undefined);
      release();
    },
  });
}

export class SpecgitBinaryFetch {
  private readonly server: string;
  private readonly fetchFn: BinaryFetchFn;
  private readonly pause: (ms: number) => Promise<void>;
  private readonly deadlineMs: number;

  constructor(private readonly options: BinaryFetchOptions) {
    this.server = normalizeServer(options.server);
    this.fetchFn = options.fetchFn ?? ((input, init) => window.fetch(input, init));
    this.pause = options.pause ?? ((ms) => new Promise((done) => window.setTimeout(done, ms)));
    this.deadlineMs = options.deadlineMs ?? BINARY_DEADLINE_MS;
  }

  private postBinary(url: string, headers: Record<string, string>, body: BodyInit): Promise<{ status: number; text: string }> {
    return withBearer(this.options.auth, async (token) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), this.deadlineMs);
      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            [VERSION_HEADER]: this.options.version,
            "Content-Type": "application/octet-stream",
            ...headers,
          },
          body,
          signal: controller.signal,
        });
        const text = await res.text();
        return { status: res.status, text };
      } finally {
        window.clearTimeout(timer);
      }
    });
  }

  async uploadAttachment(input: BinaryAttachmentUpload): Promise<BinaryStepResult> {
    const named = splitRepo(input.note.repo);
    if (!named) return { ok: false, status: 0, code: null, message: TRY_AGAIN, body: null };
    const meta = encodeMetaHeader({
      provider: GIT_PROVIDER,
      owner: named.owner,
      repo: named.repo,
      branch: NOTE_BRANCH,
      path: input.note.path,
      filePath: input.filePath,
      blobSha: input.blobSha,
      ...(input.expectSha === undefined ? {} : { expectSha: input.expectSha }),
      ...(input.createOver === undefined ? {} : { createOver: input.createOver }),
    });
    const url = `${this.server}/api/docs/attachment/upload`;
    const bodyInit: BodyInit = ArrayBuffer.isView(input.body)
      ? new Uint8Array(input.body.buffer as ArrayBuffer, input.body.byteOffset, input.body.byteLength)
      : input.body;
    try {
      const answer = await this.postBinary(url, { "X-Specgit-Meta": meta }, bodyInit);
      const parsed = parseApiAnswer(answer.status, answer.text);
      if (parsed.status >= 200 && parsed.status < 300) {
        if (!parsed.body) return { ok: false, status: 0, code: "network", message: NETWORK_MESSAGE, body: null };
        return { ok: true, body: parsed.body };
      }
      return { ok: false, status: parsed.status, code: parsed.code, message: parsed.message ?? TRY_AGAIN, body: parsed.body };
    } catch {
      return { ok: false, status: 0, code: "network", message: NETWORK_MESSAGE, body: null };
    }
  }

  async uploadVaultPack(meta: VaultPackMeta, blobs: readonly (Blob | Uint8Array)[]): Promise<ApiAnswer> {
    const answer = await this.postBinary(`${this.server}/api/vault-upload/pack`, {}, encodeVaultPackBody(meta, blobs));
    return parseApiAnswer(answer.status, answer.text);
  }

  async downloadAsset(repo: string, params: { branch: string; path: string; embed?: string; ifNoneMatch?: string }): Promise<AttachmentFile> {
    const named = splitRepo(repo);
    if (!named) return { kind: "unreadable" };
    const query = new URLSearchParams({
      provider: GIT_PROVIDER,
      owner: named.owner,
      repo: named.repo,
      branch: params.branch,
      path: params.path,
      ...(params.embed === undefined ? {} : { embed: params.embed }),
    });
    const url = `${this.server}/api/docs/asset?${query.toString()}`;
    const ifNoneMatch = formatIfNoneMatch(params.ifNoneMatch);

    const fetchOnce = async (token: string): Promise<{ status: number; res: Response; controller: AbortController; clear: () => void }> => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), this.deadlineMs);
      const clear = (): void => window.clearTimeout(timer);
      try {
        const res = await this.fetchFn(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            [VERSION_HEADER]: this.options.version,
            ...(ifNoneMatch === undefined ? {} : { "If-None-Match": ifNoneMatch }),
          },
          signal: controller.signal,
        });
        return { status: res.status, res, controller, clear };
      } catch (err) {
        clear();
        throw err;
      }
    };

    const fetchWithRetry = async (token: string): Promise<{ status: number; res: Response; controller: AbortController; clear: () => void }> => {
      const got = await retryGet(() => fetchOnce(token), isAbortError, this.pause);
      if (got.status === 401) {
        got.clear();
        await cancelBody(got.res);
      }
      return got;
    };

    try {
      const { res, controller, clear } = await withBearer(this.options.auth, fetchWithRetry);
      if (res.status === 304) {
        clear();
        await cancelBody(res);
        return { kind: "unchanged" };
      }
      if (res.status === 404) {
        clear();
        await cancelBody(res);
        return { kind: "absent" };
      }
      if (res.status === 429 || res.status >= 500) {
        clear();
        await cancelBody(res);
        return { kind: "unreadable", outage: true };
      }
      if (res.status !== 200) {
        clear();
        await cancelBody(res);
        return { kind: "unreadable" };
      }

      const foundPath = decodeHeaderPath(res.headers.get("x-specgit-path"));
      const rawLen = res.headers.get("content-length")?.trim();
      let size: number | undefined;
      if (rawLen !== undefined && /^\d+$/.test(rawLen)) {
        const parsed = Number(rawLen);
        if (!Number.isSafeInteger(parsed) || parsed > MAX_ATTACHMENT_BYTES) {
          clear();
          await cancelBody(res);
          return { kind: "unreadable" };
        }
        size = parsed;
      }
      const sha = parseEtagSha(res.headers.get("etag"));

      if (res.body !== null) {
        return {
          kind: "stream",
          stream: deadlineGuardedStream(res.body, controller, clear),
          ...(size === undefined ? {} : { size }),
          ...(foundPath === undefined ? {} : { path: foundPath }),
          ...(sha === undefined ? {} : { sha }),
        };
      }
      try {
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { kind: "unreadable" };
        return {
          kind: "bytes",
          bytes,
          ...(foundPath === undefined ? {} : { path: foundPath }),
          ...(sha === undefined ? {} : { sha }),
        };
      } finally {
        clear();
      }
    } catch {
      return { kind: "unreadable", outage: true };
    }
  }
}
