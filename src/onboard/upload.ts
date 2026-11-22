import type { ApiAnswer } from "../api";
import { AuthError } from "../auth/errors";
import { gitBlobShaOfStream } from "../changes/blob-sha";
import {
  GITHUB_TEMPLATE_FILES,
  JSON_ATTACHMENT_MAX_BYTES,
  VAULT_FILE_MAX_BYTES,
  VAULT_PACK_MAX_BYTES,
  type VaultFile,
  type VaultPackEntry,
  type VaultPackMeta,
  vaultWeight,
} from "../shared/review-flow";
import { type VaultPlan, packBinaryParts, packParts, planVault, sendAs } from "./plan";

export type UploadProgress =
  | { kind: "reading"; done: number; total: number }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "waiting"; why: "slow" | "offline" }
  | { kind: "done"; repo: string; commit: string }
  | { kind: "stopped" }
  | { kind: "failed"; why: "changed" | "gone" | "not_empty" | "public" | "failed" };

export interface UploadDeps {
  call(action: string, body: Record<string, unknown>): Promise<ApiAnswer>;
  listed(): Array<{ path: string; size: number }>;
  config(): Promise<Array<{ path: string; size: number }>>;
  ownGitignore(): Promise<string | null>;
  read(path: string): Promise<Uint8Array>;
  blobSha(bytes: Uint8Array): Promise<string>;
  hashFile?(path: string, size: number): Promise<string>;
  readBlob?(path: string): Promise<Blob | Uint8Array>;
  sendPack?(meta: VaultPackMeta, blobs: readonly (Blob | Uint8Array)[]): Promise<ApiAnswer>;
  wait(ms: number): Promise<void>;
  now(): number;
  isCurrent(): boolean;
  progress(state: UploadProgress): void;
  configDir: string;
  expectPrivate?: boolean;
}

const OFFLINE_WAITS_MS = [5_000, 15_000, 30_000, 60_000];
const OFFLINE_GIVE_UP_MS = 30 * 60_000;
const SLOW_MIN_MS = 5_000;
const SLOW_MAX_MS = 900_000;
const MAX_ROUNDS = 3;

const SMALL_HASH_BYTES = 4 * 1024 * 1024;

interface Entry {
  sha: string;
  size: number;
  kind?: "text" | "base64";
  weight?: number;
}

type Asked = { answer: ApiAnswer } | "again" | "ended";

interface Branch {
  workHead: string;
  files: Record<string, string>;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const asFiles = (value: unknown): Record<string, string> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, string>) : null);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

async function hashPayload(payload: Blob | Uint8Array, blobSha: (bytes: Uint8Array) => Promise<string>): Promise<string> {
  if (ArrayBuffer.isView(payload)) return blobSha(payload);
  if (payload.size <= SMALL_HASH_BYTES && typeof payload.arrayBuffer === "function") {
    return blobSha(new Uint8Array(await payload.arrayBuffer()));
  }
  if (typeof payload.stream === "function") return gitBlobShaOfStream(payload.size, payload.stream());
  return blobSha(new Uint8Array(await payload.arrayBuffer()));
}

export class VaultUpload {
  private readonly entries = new Map<string, Entry>();
  private offlineSince: number | null = null;
  private offlineCount = 0;
  private packUnsupported = false;
  private badPackRetries = 0;

  constructor(private readonly deps: UploadDeps) {}

  private usePack(): boolean {
    return this.deps.sendPack !== undefined && !this.packUnsupported;
  }

  async run(repo: string): Promise<void> {
    try {
      await this.upload(repo);
    } catch (error) {
      this.deps.progress(error instanceof AuthError && error.code === "signed_out" ? { kind: "stopped" } : { kind: "failed", why: "failed" });
    }
  }

  private async upload(repo: string): Promise<void> {
    for (;;) {
      if ((await this.pass(repo)) === "ended") return;
    }
  }

  private async plan(): Promise<VaultPlan> {
    const { deps } = this;
    return planVault(deps.listed(), await deps.config(), deps.configDir, await deps.ownGitignore());
  }

  private async sync(): Promise<VaultPlan | "again" | "ended"> {
    const { deps, entries } = this;
    if (!deps.isCurrent()) return this.stopped();
    const plan = await this.plan();
    const paths = new Set(plan.files.map((file) => file.path));
    for (const path of [...entries.keys()]) if (!paths.has(path)) entries.delete(path);
    for (const { path, size } of plan.files) {
      if (entries.has(path)) continue;
      if (!deps.isCurrent()) return this.stopped();
      try {
        entries.set(path, await this.hashEntry(path, size, plan));
      } catch (error) {
        return this.leftOrFailed(path, error);
      }
      deps.progress({ kind: "reading", done: entries.size, total: plan.files.length });
    }
    return plan;
  }

  private async leftOrFailed(path: string, error: unknown): Promise<"again"> {
    if ((await this.plan()).files.some((file) => file.path === path)) throw error;
    return "again";
  }

  private async hashEntry(path: string, size: number, plan: VaultPlan): Promise<Entry> {
    if (this.deps.hashFile && path !== ".gitignore") {
      return { sha: await this.deps.hashFile(path, size), size };
    }
    return (await this.measure(path, plan)).entry;
  }

  private async measure(path: string, plan: VaultPlan): Promise<{ bytes: Uint8Array; entry: Entry }> {
    const bytes = path === ".gitignore" ? new TextEncoder().encode(plan.gitignore) : await this.deps.read(path);
    const kind = sendAs(path, bytes, this.deps.configDir);
    return { bytes, entry: { sha: await this.deps.blobSha(bytes), size: bytes.length, kind, weight: vaultWeight(kind, bytes.length) } };
  }

  private stopped(): "ended" {
    this.deps.progress({ kind: "stopped" });
    return "ended";
  }

  private end(why: Extract<UploadProgress, { kind: "failed" }>["why"]): "ended" {
    this.deps.progress({ kind: "failed", why });
    return "ended";
  }

  private async requestWith(send: () => Promise<ApiAnswer>): Promise<Asked> {
    const { deps } = this;
    for (;;) {
      if (!deps.isCurrent()) return this.stopped();
      let answer: ApiAnswer;
      try {
        answer = await send();
      } catch (error) {
        if (error instanceof AuthError && error.code === "signed_out") return this.stopped();
        return this.waitOffline();
      }
      if (answer.code === "github_unavailable" || answer.status === 502) return this.waitOffline();
      this.offlineSince = null;
      this.offlineCount = 0;
      if (answer.code !== "rate_limited") return { answer };
      const asked = answer.body?.retryAfterMs;
      deps.progress({ kind: "waiting", why: "slow" });
      await deps.wait(Math.min(Math.max(typeof asked === "number" ? asked : 0, SLOW_MIN_MS), SLOW_MAX_MS));
    }
  }

  private request(action: string, body: Record<string, unknown>): Promise<Asked> {
    return this.requestWith(() => this.deps.call(action, body));
  }

  private async waitOffline(): Promise<Asked> {
    const { deps } = this;
    this.offlineSince ??= deps.now();
    if (deps.now() - this.offlineSince > OFFLINE_GIVE_UP_MS) return this.end("failed");
    deps.progress({ kind: "waiting", why: "offline" });
    await deps.wait(OFFLINE_WAITS_MS[Math.min(this.offlineCount++, OFFLINE_WAITS_MS.length - 1)]!);
    return "again";
  }

  private async start(repo: string, plan: VaultPlan): Promise<Branch | "again" | "ended"> {
    const asked = await this.request("start", { repo, gitignore: plan.gitignore, ...(this.deps.expectPrivate === true ? { expectPrivate: true } : {}) });
    if (typeof asked === "string") return asked;
    const { answer } = asked;
    if (answer.status === 404) return this.end("gone");
    if (answer.code === "not_empty") return this.end("not_empty");
    if (answer.code === "repo_public" || (answer.status === 200 && this.deps.expectPrivate === true && answer.body?.private === false)) return this.end("public");
    const workHead = asString(answer.body?.workHead);
    const files = asFiles(answer.body?.files);
    if (answer.status !== 200 || workHead === null || files === null) return this.end("failed");
    return { workHead, files };
  }

  private async pass(repo: string): Promise<"again" | "ended"> {
    const { entries } = this;
    for (let round = 0; ; round++) {
      const plan = await this.sync();
      if (typeof plan === "string") return plan;
      const branch = await this.start(repo, plan);
      if (typeof branch === "string") return branch;
      const paths = plan.files.map((file) => file.path);
      const send = paths.filter((path) => branch.files[path] !== entries.get(path)?.sha);
      const deletes = Object.keys(branch.files).filter((path) => !entries.has(path) && !GITHUB_TEMPLATE_FILES.includes(path));
      if (send.length === 0 && deletes.length === 0) return this.finish(repo, plan, branch.workHead);
      if (round >= MAX_ROUNDS) return this.end("failed");
      const matching = paths.length - send.length;
      this.deps.progress({ kind: "uploading", done: matching, total: paths.length });
      const sent = await this.sendParts(repo, plan, branch.workHead, send, deletes, matching);
      if (sent !== "sent") return sent;
    }
  }

  private async sendParts(repo: string, plan: VaultPlan, from: string, send: string[], deletes: string[], matching: number): Promise<"sent" | "again" | "ended"> {
    if (this.usePack()) return this.sendPackParts(repo, plan, from, send, deletes, matching);
    return this.sendJsonParts(repo, plan, from, send, deletes, matching);
  }

  private applyPartAnswer(answer: ApiAnswer, sentCount: number, state: { workHead: string; done: number }, total: number): "ok" | "again" | "ended" {
    if (answer.code === "moved") return "again";
    if (answer.status === 404) return this.end("gone");
    const next = asString(answer.body?.workHead);
    if (answer.status !== 200 || next === null) return this.end("failed");
    state.workHead = next;
    state.done += sentCount;
    this.badPackRetries = 0;
    this.deps.progress({ kind: "uploading", done: state.done, total });
    return "ok";
  }

  private async sendPackParts(repo: string, plan: VaultPlan, from: string, send: string[], deletes: string[], matching: number): Promise<"sent" | "again" | "ended"> {
    const { deps, entries } = this;
    const state = { workHead: from, done: matching };
    const sized = [...deletes.map((path) => ({ path, size: 0 })), ...send.map((path) => ({ path, size: entries.get(path)?.size ?? 0 }))];
    const removed = new Set(deletes);
    for (const part of packBinaryParts(sized)) {
      const files: VaultPackEntry[] = [];
      const blobs: Array<Blob | Uint8Array> = [];
      let batchBytes = 0;
      for (const path of part) {
        if (removed.has(path)) {
          files.push({ path, delete: true });
          continue;
        }
        let blob: Blob | Uint8Array;
        try {
          blob = path === ".gitignore" ? new TextEncoder().encode(plan.gitignore) : deps.readBlob ? await deps.readBlob(path) : await deps.read(path);
        } catch (error) {
          return this.leftOrFailed(path, error);
        }
        const blobSize = ArrayBuffer.isView(blob) ? blob.byteLength : blob.size;
        if (blobSize > VAULT_FILE_MAX_BYTES) {
          entries.delete(path);
          return "again";
        }
        const sha = await hashPayload(blob, (bytes) => deps.blobSha(bytes));
        entries.set(path, { sha, size: blobSize });
        batchBytes += blobSize;
        if (blobs.length >= 1 && batchBytes > VAULT_PACK_MAX_BYTES) {
          return "again";
        }
        files.push({ path, size: blobSize, blobSha: sha });
        blobs.push(blob);
      }
      const meta: VaultPackMeta = { repo, workHead: state.workHead, files };
      const asked = await this.requestWith(() => deps.sendPack!(meta, blobs));
      if (typeof asked === "string") return asked;
      const { answer } = asked;
      if ((answer.status === 404 && answer.body === null) || answer.status === 405 || answer.status === 501) {
        const fitsLegacy = plan.files.every((file) => Math.max(entries.get(file.path)?.size ?? 0, file.size) <= JSON_ATTACHMENT_MAX_BYTES);
        if (fitsLegacy) {
          this.packUnsupported = true;
          return "again";
        }
        return this.end("failed");
      }
      if (answer.status === 400 && answer.code === "bad_request" && this.badPackRetries < MAX_ROUNDS) {
        this.badPackRetries++;
        for (const path of part) if (!removed.has(path)) entries.delete(path);
        return "again";
      }
      const outcome = this.applyPartAnswer(answer, blobs.length, state, plan.files.length);
      if (outcome !== "ok") return outcome;
    }
    return "sent";
  }

  private async sendJsonParts(repo: string, plan: VaultPlan, from: string, send: string[], deletes: string[], matching: number): Promise<"sent" | "again" | "ended"> {
    const { entries } = this;
    const state = { workHead: from, done: matching };
    const weights = [
      ...deletes.map((path) => ({ path, weight: vaultWeight("delete", 0) })),
      ...send.map((path) => {
        const entry = entries.get(path);
        return { path, weight: entry?.weight ?? vaultWeight("base64", entry?.size ?? 0) };
      }),
    ];
    const removed = new Set(deletes);
    for (const part of packParts(weights)) {
      const files: VaultFile[] = [];
      let sentCount = 0;
      for (const path of part) {
        if (removed.has(path)) files.push({ path, delete: true });
        else {
          try {
            files.push(await this.fileOf(path, plan));
            sentCount++;
          } catch (error) {
            return this.leftOrFailed(path, error);
          }
        }
      }
      const asked = await this.request("add", { repo, workHead: state.workHead, files });
      if (typeof asked === "string") return asked;
      const outcome = this.applyPartAnswer(asked.answer, sentCount, state, plan.files.length);
      if (outcome !== "ok") return outcome;
    }
    return "sent";
  }

  private async fileOf(path: string, plan: VaultPlan): Promise<VaultFile> {
    const { bytes, entry } = await this.measure(path, plan);
    this.entries.set(path, entry);
    return entry.kind === "text" ? { path, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) } : { path, base64: toBase64(bytes) };
  }

  private async finish(repo: string, plan: VaultPlan, workHead: string): Promise<"again" | "ended"> {
    const asked = await this.request("finish", { repo, workHead, count: plan.files.length });
    if (typeof asked === "string") return asked;
    const { answer } = asked;
    if (answer.code === "moved") return "again";
    if (answer.code === "changed") return this.end("changed");
    if (answer.status === 404) return this.end("gone");
    const commit = asString(answer.body?.commit);
    const files = asFiles(answer.body?.files);
    if (answer.status !== 200 || commit === null || files === null) return this.end("failed");
    if (plan.files.some((file) => files[file.path] !== this.entries.get(file.path)?.sha)) return this.end("failed");
    this.deps.progress({ kind: "done", repo, commit });
    return "ended";
  }
}
