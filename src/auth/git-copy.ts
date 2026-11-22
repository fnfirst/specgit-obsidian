import type { DocumentRef } from "../mapping";
import { type Bearer, withBearer } from "./bearer";
import { formatIfNoneMatch, parseEtagSha, type SpecgitBinaryFetch } from "./binary-fetch";
import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer, VERSION_HEADER } from "./config";
import { decodeHeaderPath, headerOf, jsonObject, type Transport } from "./transport";

export interface GitCopyOptions {
  server: string;
  version: string;
  auth: Bearer;
  transport: Transport;
  binaryFetch?: Pick<SpecgitBinaryFetch, "downloadAsset">;
}

export type MainFile =
  | { kind: "absent" }
  | { kind: "file"; text: string; sha: string }
  | { kind: "unreadable"; outage?: true };

export type BranchFile = MainFile;

export type BlobRead = { kind: "text"; text: string } | { kind: "too_large" | "not_text" | "changed" };

const BLOBS_KEPT = 50;

export type BlobsAnswer = { kind: "answered"; files: Map<string, BlobRead> } | { kind: "missing" } | { kind: "outage" };

export type AttachmentFile =
  | { kind: "bytes"; bytes: ArrayBuffer; path?: string; sha?: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array>; size?: number; path?: string; sha?: string }
  | { kind: "unchanged" }
  | { kind: "absent" }
  | { kind: "unreadable"; outage?: true };

const BLOB_KINDS: ReadonlySet<string> = new Set(["too_large", "not_text", "changed"]);

export class SpecgitGitCopy {
  private readonly server: string;

  constructor(private readonly options: GitCopyOptions) {
    this.server = normalizeServer(options.server);
  }

  private async content(doc: DocumentRef, which: Record<string, string>): Promise<Record<string, unknown> | null> {
    return (await this.contentOrOutage(doc, which)).body;
  }

  private async contentOrOutage(doc: DocumentRef, which: Record<string, string>): Promise<{ body: Record<string, unknown> | null; outage: boolean }> {
    const [owner, repo, ...rest] = doc.repo.split("/");
    if (!owner || !repo || rest.length > 0) return { body: null, outage: false };
    const query = new URLSearchParams({ provider: GIT_PROVIDER, owner, repo, branch: NOTE_BRANCH, path: doc.path, ...which });
    try {
      const response = await withBearer(this.options.auth, (token) =>
        this.options.transport({
          url: `${this.server}/api/docs/content?${query.toString()}`,
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version },
        }),
      );
      if (response.status === 200) return { body: jsonObject(response.text), outage: false };
      return { body: null, outage: response.status === 429 || response.status >= 500 };
    } catch {
      return { body: null, outage: true };
    }
  }

  async readFile(doc: DocumentRef, at?: string): Promise<MainFile> {
    const { body, outage } = await this.contentOrOutage(doc, at === undefined ? { base: "1" } : { at });
    if (!body) return outage ? { kind: "unreadable", outage: true } : { kind: "unreadable" };
    if (body.exists === false) return { kind: "absent" };
    return body.exists === true && typeof body.source === "string" && typeof body.sha === "string" ? { kind: "file", text: body.source, sha: body.sha } : { kind: "unreadable" };
  }

  async wasDeleted(doc: DocumentRef): Promise<{ deletedAt: number } | null | "unknown"> {
    const { body } = await this.contentOrOutage(doc, {});
    if (!body) return "unknown";
    if (body.deleted !== true) return body.exists === true || body.exists === false ? null : "unknown";
    return typeof body.deletedAt === "number" && Number.isFinite(body.deletedAt) ? { deletedAt: body.deletedAt } : "unknown";
  }

  async readBranchFile(doc: DocumentRef, branch: string): Promise<BranchFile> {
    const body = await this.content(doc, { branch });
    if (!body) return { kind: "unreadable" };
    if (body.exists === false || (typeof body.gitBranch === "string" && body.gitBranch !== branch)) return { kind: "absent" };
    return body.exists === true && typeof body.source === "string" && typeof body.sha === "string" ? { kind: "file", text: body.source, sha: body.sha } : { kind: "unreadable" };
  }

  async readBlob(doc: DocumentRef, sha: string): Promise<string | null> {
    const key = `${doc.repo}\n${sha}`;
    const kept = this.blobs.get(key);
    if (kept !== undefined) return kept;
    const body = await this.content(doc, { blob: sha });
    if (typeof body?.source !== "string") return null;
    this.blobs.set(key, body.source);
    if (this.blobs.size > BLOBS_KEPT) this.blobs.delete(this.blobs.keys().next().value!);
    return body.source;
  }
  private readonly blobs = new Map<string, string>();

  async readBlobs(repo: string, commit: string | null, files: ReadonlyArray<{ sha: string; path: string }>, byBlob = false): Promise<BlobsAnswer> {
    const [owner, name, ...rest] = repo.split("/");
    if (!owner || !name || rest.length > 0) return { kind: "missing" };
    try {
      const response = await withBearer(this.options.auth, (token) =>
        this.options.transport({
          url: `${this.server}/api/docs/content/batch`,
          method: "POST",
          contentType: "application/json",
          headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version },
          body: JSON.stringify({ provider: GIT_PROVIDER, owner, repo: name, ...(byBlob ? { byBlob: true } : { commit }), files }),
        }),
      );
      if (response.status === 429 || response.status >= 500) return { kind: "outage" };
      const body = response.status === 200 ? jsonObject(response.text) : null;
      if (!body || !Array.isArray(body.files)) return { kind: "missing" };
      const read = new Map<string, BlobRead>();
      for (const one of body.files as unknown[]) {
        const file = one as { sha?: unknown; kind?: unknown; text?: unknown } | null;
        if (typeof file?.sha !== "string") continue;
        if (file.kind === "text" && typeof file.text === "string") read.set(file.sha, { kind: "text", text: file.text });
        else if (typeof file.kind === "string" && BLOB_KINDS.has(file.kind)) read.set(file.sha, { kind: file.kind as "too_large" | "not_text" | "changed" });
      }
      return { kind: "answered", files: read };
    } catch {
      return { kind: "outage" };
    }
  }

  async readExist(repo: string, paths: ReadonlyArray<string>): Promise<{ kind: "answered"; files: Map<string, boolean> } | { kind: "missing" } | { kind: "outage" }> {
    const [owner, name, ...rest] = repo.split("/");
    if (!owner || !name || rest.length > 0) return { kind: "missing" };
    try {
      const response = await withBearer(this.options.auth, (token) =>
        this.options.transport({
          url: `${this.server}/api/docs/content/batch`,
          method: "POST",
          contentType: "application/json",
          headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version },
          body: JSON.stringify({ provider: GIT_PROVIDER, owner, repo: name, exist: paths, branch: NOTE_BRANCH }),
        }),
      );
      if (response.status === 429 || response.status >= 500) return { kind: "outage" };
      const body = response.status === 200 ? jsonObject(response.text) : null;
      if (!body || !Array.isArray(body.files)) return { kind: "missing" };
      const files = new Map<string, boolean>();
      for (const one of body.files as unknown[]) {
        const file = one as { path?: unknown; exists?: unknown } | null;
        if (typeof file?.path === "string" && typeof file.exists === "boolean") files.set(file.path, file.exists);
      }
      return { kind: "answered", files };
    } catch {
      return { kind: "outage" };
    }
  }

  async readAttachment(repo: string, commit: string, path: string, options?: { ifNoneMatch?: string }): Promise<AttachmentFile> {
    return this.fetchAttachment(repo, { branch: commit, path, ...(options?.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }) });
  }

  async findAttachment(repo: string, branch: string, notePath: string, embed: string): Promise<AttachmentFile> {
    return this.fetchAttachment(repo, { branch, path: notePath, embed });
  }

  private async fetchAttachment(repo: string, params: { branch: string; path: string; embed?: string; ifNoneMatch?: string }): Promise<AttachmentFile> {
    if (this.options.binaryFetch) return this.options.binaryFetch.downloadAsset(repo, params);
    const [owner, name, ...rest] = repo.split("/");
    if (!owner || !name || rest.length > 0) return { kind: "unreadable" };
    const query = new URLSearchParams({ provider: GIT_PROVIDER, owner, repo: name, branch: params.branch, path: params.path, ...(params.embed === undefined ? {} : { embed: params.embed }) });
    const ifNoneMatch = formatIfNoneMatch(params.ifNoneMatch);
    try {
      const response = await withBearer(this.options.auth, (token) =>
        this.options.transport({
          url: `${this.server}/api/docs/asset?${query.toString()}`,
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version, ...(ifNoneMatch === undefined ? {} : { "If-None-Match": ifNoneMatch }) },
          binary: true,
        }),
      );
      if (response.status === 304) return { kind: "unchanged" };
      if (response.status === 200 && response.bytes) {
        const found = decodeHeaderPath(headerOf(response, "x-specgit-path"));
        const sha = parseEtagSha(headerOf(response, "etag"));
        return { kind: "bytes", bytes: response.bytes, ...(found === undefined ? {} : { path: found }), ...(sha === undefined ? {} : { sha }) };
      }
      if (response.status === 404) return { kind: "absent" };
      return response.status === 429 || response.status >= 500 ? { kind: "unreadable", outage: true } : { kind: "unreadable" };
    } catch {
      return { kind: "unreadable", outage: true };
    }
  }

  async read(doc: DocumentRef): Promise<string | null> {
    const file = await this.readFile(doc);
    return file.kind === "file" ? file.text : null;
  }
}
