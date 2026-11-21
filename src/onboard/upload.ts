import type { ApiAnswer } from "../api";
import { AuthError } from "../auth/errors";
import { GITHUB_TEMPLATE_FILES, type VaultFile, vaultWeight } from "../shared/review-flow";
import { type VaultPlan, packParts, planVault, sendAs } from "./plan";

export type UploadProgress =
  | { kind: "reading"; done: number; total: number }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "waiting"; why: "slow" | "offline" }
  | { kind: "done"; repo: string; commit: string }
  | { kind: "stopped" }
  | { kind: "failed"; why: "changed" | "gone" | "not_empty" | "failed" };

export interface UploadDeps {
  call(action: string, body: Record<string, unknown>): Promise<ApiAnswer>;
  listed(): Array<{ path: string; size: number }>;
  config(): Promise<Array<{ path: string; size: number }>>;
  ownGitignore(): Promise<string | null>;
  read(path: string): Promise<Uint8Array>;
  blobSha(bytes: Uint8Array): Promise<string>;
  wait(ms: number): Promise<void>;
  now(): number;
  isCurrent(): boolean;
  progress(state: UploadProgress): void;
  configDir: string;
}

const OFFLINE_WAITS_MS = [5_000, 15_000, 30_000, 60_000];
const OFFLINE_GIVE_UP_MS = 30 * 60_000;
const SLOW_MIN_MS = 5_000;
const SLOW_MAX_MS = 900_000;
const MAX_ROUNDS = 3;

interface Entry {
  sha: string;
  kind: "text" | "base64";
  weight: number;
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

export class VaultUpload {
  private readonly entries = new Map<string, Entry>();
  private offlineSince: number | null = null;
  private offlineCount = 0;

  constructor(private readonly deps: UploadDeps) {}

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
    for (const { path } of plan.files) {
      if (entries.has(path)) continue;
      if (!deps.isCurrent()) return this.stopped();
      try {
        entries.set(path, (await this.measure(path, plan)).entry);
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

  private async measure(path: string, plan: VaultPlan): Promise<{ bytes: Uint8Array; entry: Entry }> {
    const bytes = path === ".gitignore" ? new TextEncoder().encode(plan.gitignore) : await this.deps.read(path);
    const kind = sendAs(path, bytes, this.deps.configDir);
    return { bytes, entry: { sha: await this.deps.blobSha(bytes), kind, weight: vaultWeight(kind, bytes.length) } };
  }

  private stopped(): "ended" {
    this.deps.progress({ kind: "stopped" });
    return "ended";
  }

  private end(why: Extract<UploadProgress, { kind: "failed" }>["why"]): "ended" {
    this.deps.progress({ kind: "failed", why });
    return "ended";
  }

  private async request(action: string, body: Record<string, unknown>): Promise<Asked> {
    const { deps } = this;
    for (;;) {
      if (!deps.isCurrent()) return this.stopped();
      let answer: ApiAnswer;
      try {
        answer = await deps.call(action, body);
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

  private async waitOffline(): Promise<Asked> {
    const { deps } = this;
    this.offlineSince ??= deps.now();
    if (deps.now() - this.offlineSince > OFFLINE_GIVE_UP_MS) return this.end("failed");
    deps.progress({ kind: "waiting", why: "offline" });
    await deps.wait(OFFLINE_WAITS_MS[Math.min(this.offlineCount++, OFFLINE_WAITS_MS.length - 1)]!);
    return "again";
  }

  private async start(repo: string, plan: VaultPlan): Promise<Branch | "again" | "ended"> {
    const asked = await this.request("start", { repo, gitignore: plan.gitignore });
    if (typeof asked === "string") return asked;
    const { answer } = asked;
    if (answer.status === 404) return this.end("gone");
    if (answer.code === "not_empty") return this.end("not_empty");
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
    const { deps, entries } = this;
    let workHead = from;
    let done = matching;
    const weights = [...deletes.map((path) => ({ path, weight: vaultWeight("delete", 0) })), ...send.map((path) => ({ path, weight: entries.get(path)?.weight ?? 0 }))];
    const removed = new Set(deletes);
    for (const part of packParts(weights)) {
      const files: VaultFile[] = [];
      for (const path of part) {
        if (removed.has(path)) files.push({ path, delete: true });
        else
          try {
            files.push(await this.fileOf(path, plan));
          } catch (error) {
            return this.leftOrFailed(path, error);
          }
      }
      const asked = await this.request("add", { repo, workHead, files });
      if (typeof asked === "string") return asked;
      const { answer } = asked;
      if (answer.code === "moved") return "again";
      if (answer.status === 404) return this.end("gone");
      const next = asString(answer.body?.workHead);
      if (answer.status !== 200 || next === null) return this.end("failed");
      workHead = next;
      done += part.filter((path) => !removed.has(path)).length;
      deps.progress({ kind: "uploading", done, total: plan.files.length });
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
