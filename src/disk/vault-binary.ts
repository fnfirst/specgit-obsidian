import { type App, type DataAdapter, requireApiVersion } from "obsidian";
import { attachmentMove } from "../changes/attachment-memory";
import { gitBlobSha, gitBlobShaOfStream, readStreamBounded, StreamingSha1 } from "../changes/blob-sha";
import { isVaultTarget } from "../mapping";
import { MAX_ATTACHMENT_BYTES } from "../shared/review-flow";
import { guardedBinaryCreate, hasVaultCaseCollision } from "./guarded-vault";

const configDirOf = (app: App): string => (app.vault as { configDir?: string }).configDir ?? "";

export const WRITE_CHUNK_BYTES = 2 * 1024 * 1024;

export const STREAM_HASH_THRESHOLD = 4 * 1024 * 1024;

export type StreamCreateResult = { status: "created"; sha: string } | { status: "exists" | "failed" | "outage" };

export type StreamReplaceResult = { outcome: "replaced"; sha: string } | { outcome: "same"; sha: string } | { outcome: "both" | "skipped" | "outage" };

export type CommitScope = <T>(run: () => Promise<T>) => Promise<T>;

export interface StreamingVaultPorts {
  configDir?: string;
  exists(path: string): Promise<boolean> | boolean;
  ensureFolder(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  appendBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  createBinary(path: string, data: ArrayBuffer): Promise<"created" | "exists" | "failed">;
  modifyBinary(path: string, data: ArrayBuffer): Promise<boolean>;
  hashExisting(path: string): Promise<string | null>;
  hashPath(path: string, size: number): Promise<string>;
  randomHex?: () => string;
}

type StagedTemp = { ok: true; tmp: string; sha: string; written: number } | { ok: false; outage: boolean };

function defaultRandomHex(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hiddenSibling(path: string, prefix: string, hex: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  return dir === "" ? `.${prefix}-${hex}` : `${dir}/.${prefix}-${hex}`;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

async function streamToTempFile(
  ports: StreamingVaultPorts,
  targetPath: string,
  stream: ReadableStream<Uint8Array>,
  expectedSize?: number,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<StagedTemp> {
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes)) {
    await stream.cancel().catch(() => undefined);
    return { ok: false, outage: false };
  }
  const tmp = hiddenSibling(targetPath, "specgit-tmp", (ports.randomHex ?? defaultRandomHex)());
  const reader = stream.getReader();
  const hasher = expectedSize !== undefined ? new StreamingSha1().update(new TextEncoder().encode(`blob ${expectedSize}\0`)) : null;
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let written = 0;
  let createdTmp = false;
  let eof = false;
  let outage = false;

  const flush = async (data: Uint8Array): Promise<void> => {
    const buf = toExactArrayBuffer(data);
    if (!createdTmp) {
      await ports.writeBinary(tmp, buf);
      createdTmp = true;
    } else {
      await ports.appendBinary!(tmp, buf);
    }
  };

  const flushPending = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    if (pending.length === 1) {
      const only = pending[0]!;
      pending.length = 0;
      pendingBytes = 0;
      await flush(only);
      return;
    }
    const combined = new Uint8Array(pendingBytes);
    let at = 0;
    for (const part of pending) {
      combined.set(part, at);
      at += part.byteLength;
    }
    pending.length = 0;
    pendingBytes = 0;
    await flush(combined);
  };

  try {
    await ports.ensureFolder(targetPath);
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        outage = true;
        throw new Error("stream");
      }
      if (step.done) {
        eof = true;
        break;
      }
      const { value } = step;
      if (!value || value.byteLength === 0) continue;
      written += value.byteLength;
      if (written > maxBytes || (expectedSize !== undefined && written > expectedSize)) {
        throw new Error("overflow");
      }
      hasher?.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(WRITE_CHUNK_BYTES - pendingBytes, value.byteLength - offset);
        pending.push(value.subarray(offset, offset + take));
        pendingBytes += take;
        offset += take;
        if (pendingBytes >= WRITE_CHUNK_BYTES) await flushPending();
      }
    }
    if (expectedSize !== undefined && written !== expectedSize) {
      outage = true;
      throw new Error("truncated");
    }
    if (pendingBytes > 0) await flushPending();
    else if (!createdTmp) {
      await ports.writeBinary(tmp, new ArrayBuffer(0));
      createdTmp = true;
    }
    const sha = hasher !== null ? hasher.digestHex() : await ports.hashPath(tmp, written);
    return { ok: true, tmp, sha, written };
  } catch {
    await ports.remove(tmp).catch(() => undefined);
    return { ok: false, outage };
  } finally {
    if (!eof) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function createBinaryFromStream(
  ports: StreamingVaultPorts,
  path: string,
  stream: ReadableStream<Uint8Array>,
  size?: number,
  maxBytes = MAX_ATTACHMENT_BYTES,
  commit: CommitScope = (run) => run(),
): Promise<StreamCreateResult> {
  if (!isVaultTarget(path, ports.configDir)) {
    await stream.cancel().catch(() => undefined);
    return { status: "failed" };
  }
  if (await ports.exists(path)) {
    await stream.cancel().catch(() => undefined);
    return { status: "exists" };
  }
  if (!ports.appendBinary) {
    const got = await readStreamBounded(stream, maxBytes, size);
    if (!got.ok) return { status: got.outage ? "outage" : "failed" };
    const sha = await gitBlobSha(got.bytes);
    if (await ports.exists(path)) return { status: "exists" };
    const status = await commit(() => ports.createBinary(path, got.bytes));
    return status === "created" ? { status: "created", sha } : { status };
  }
  const staged = await streamToTempFile(ports, path, stream, size, maxBytes);
  if (!staged.ok) return { status: staged.outage ? "outage" : "failed" };
  let moved = false;
  try {
    if (await ports.exists(path)) return { status: "exists" };
    return await commit(async () => {
      if (await ports.exists(path)) return { status: "exists" as const };
      await ports.rename(staged.tmp, path);
      moved = true;
      return { status: "created" as const, sha: staged.sha };
    });
  } catch {
    return (await ports.exists(path)) ? { status: "exists" } : { status: "failed" };
  } finally {
    if (!moved) await ports.remove(staged.tmp).catch(() => undefined);
  }
}

export async function replaceBinaryFromStream(
  ports: StreamingVaultPorts,
  path: string,
  stream: ReadableStream<Uint8Array>,
  options: { agreed: string; vaultSha: string; size?: number },
  maxBytes = MAX_ATTACHMENT_BYTES,
  commit: CommitScope = (run) => run(),
): Promise<StreamReplaceResult> {
  if (!isVaultTarget(path, ports.configDir)) {
    await stream.cancel().catch(() => undefined);
    return { outcome: "skipped" };
  }
  if (!ports.appendBinary) {
    const got = await readStreamBounded(stream, maxBytes, options.size);
    if (!got.ok) return { outcome: got.outage ? "outage" : "skipped" };
    const draftSha = await gitBlobSha(got.bytes);
    const move = attachmentMove(options.vaultSha, options.agreed, draftSha);
    if (move === "same") return { outcome: "same", sha: draftSha };
    if (move === "both") return { outcome: "both" };
    const currentSha = await ports.hashExisting(path);
    if (currentSha === null || currentSha !== options.vaultSha) return { outcome: "skipped" };
    return (await commit(() => ports.modifyBinary(path, got.bytes))) ? { outcome: "replaced", sha: draftSha } : { outcome: "skipped" };
  }
  const staged = await streamToTempFile(ports, path, stream, options.size, maxBytes);
  if (!staged.ok) return { outcome: staged.outage ? "outage" : "skipped" };
  let moved = false;
  try {
    const move = attachmentMove(options.vaultSha, options.agreed, staged.sha);
    if (move === "same") return { outcome: "same", sha: staged.sha };
    if (move === "both") return { outcome: "both" };
    const currentSha = await ports.hashExisting(path);
    if (currentSha === null || currentSha !== options.vaultSha) return { outcome: "skipped" };
    return await commit(async () => {
      try {
        await ports.rename(staged.tmp, path);
        moved = true;
        return { outcome: "replaced" as const, sha: staged.sha };
      } catch {
        const bak = hiddenSibling(path, "specgit-bak", (ports.randomHex ?? defaultRandomHex)());
        let backedUp = false;
        try {
          await ports.rename(path, bak);
          backedUp = true;
          await ports.rename(staged.tmp, path);
          moved = true;
          await ports.remove(bak).catch(() => undefined);
          return { outcome: "replaced" as const, sha: staged.sha };
        } catch {
          if (backedUp) await ports.rename(bak, path).catch(() => undefined);
          return { outcome: "skipped" as const };
        }
      }
    });
  } finally {
    if (!moved) await ports.remove(staged.tmp).catch(() => undefined);
  }
}

async function streamHashResource(
  adapter: DataAdapter | undefined,
  path: string,
  size: number,
  fallbackRead: () => Promise<ArrayBuffer>,
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => window.fetch(input, init),
  allowLargeFallback = true,
): Promise<string | null> {
  if (size > STREAM_HASH_THRESHOLD) {
    const url = adapter?.getResourcePath?.(path);
    if (url) {
      try {
        const res = await fetchFn(url);
        if (res.ok && res.body) return await gitBlobShaOfStream(size, res.body);
        await res.body?.cancel().catch(() => undefined);
      } catch {
        if (!allowLargeFallback) return null;
      }
    }
  }
  return gitBlobSha(await fallbackRead());
}

export async function readVaultBinaryBlob(
  app: App,
  path: string,
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => window.fetch(input, init),
): Promise<Blob> {
  const adapter = app.vault.adapter as DataAdapter | undefined;
  const url = adapter?.getResourcePath?.(path);
  if (url) {
    const res = await fetchFn(url).catch(() => null);
    if (res) {
      if (res.ok) {
        const blob = await res.blob().catch(() => null);
        if (blob) return blob;
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
    }
  }
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error("gone");
  return new Blob([await app.vault.readBinary(file)]);
}

export async function hashVaultBinary(
  app: App,
  path: string,
  size: number,
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => window.fetch(input, init),
): Promise<string> {
  const adapter = app.vault.adapter as DataAdapter | undefined;
  const sha = await streamHashResource(
    adapter,
    path,
    size,
    async () => {
      const file = app.vault.getFileByPath(path);
      if (!file) throw new Error("gone");
      return app.vault.readBinary(file);
    },
    fetchFn,
  );
  if (sha === null) throw new Error("gone");
  return sha;
}

function obsidianStreamingPorts(app: App): StreamingVaultPorts {
  const { vault } = app;
  const adapter = vault.adapter as DataAdapter | undefined;
  const canAppend = requireApiVersion("1.12.3") && adapter !== undefined && typeof adapter.appendBinary === "function";
  const binaryCreate = guardedBinaryCreate(app);
  return {
    configDir: configDirOf(app),
    exists: async (path) => {
      if (vault.getAbstractFileByPath(path) !== null) return true;
      if (hasVaultCaseCollision(vault, path)) return true;
      if (!adapter || typeof adapter.exists !== "function") return false;
      try {
        return await adapter.exists(path);
      } catch {
        return false;
      }
    },
    ensureFolder: async (path) => {
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder !== "" && !vault.getFolderByPath(folder)) await vault.createFolder(folder).catch(() => undefined);
    },
    writeBinary: (path, data) => adapter!.writeBinary(path, data),
    ...(canAppend
      ? {
          appendBinary: (path: string, data: ArrayBuffer) =>
            requireApiVersion("1.12.3") ? adapter.appendBinary(path, data) : Promise.reject(new Error("unsupported")),
        }
      : {}),
    rename: (from, to) => adapter!.rename(from, to),
    remove: (path) => adapter!.remove(path),
    createBinary: (path, data) => binaryCreate(path, data),
    modifyBinary: async (path, data) => {
      const file = vault.getFileByPath(path);
      if (!file) return false;
      await vault.modifyBinary(file, data);
      return true;
    },
    hashExisting: async (path) => {
      try {
        const hasStat = adapter !== undefined && typeof adapter.stat === "function";
        const liveStat = hasStat ? await adapter.stat(path) : null;
        if (hasStat && liveStat?.type !== "file") return null;
        const file = vault.getFileByPath(path);
        const size = liveStat?.size ?? file?.stat.size;
        if (size === undefined) return null;
        return await streamHashResource(
          adapter,
          path,
          size,
          async () => {
            if (!file) throw new Error("gone");
            return vault.readBinary(file);
          },
          undefined,
          false,
        );
      } catch {
        return null;
      }
    },
    hashPath: async (path, size) => {
      const sha = await streamHashResource(adapter, path, size, () => adapter!.readBinary(path));
      if (sha === null) throw new Error("gone");
      return sha;
    },
  };
}

export function guardedBinaryCreateStream(app: App): (path: string, stream: ReadableStream<Uint8Array>, size?: number, commit?: CommitScope) => Promise<StreamCreateResult> {
  const ports = obsidianStreamingPorts(app);
  return async (path, stream, size, commit) => {
    if (!isVaultTarget(path, configDirOf(app))) {
      await stream.cancel().catch(() => undefined);
      return { status: "failed" };
    }
    return createBinaryFromStream(ports, path, stream, size, MAX_ATTACHMENT_BYTES, commit);
  };
}

export function replaceAttachmentStream(
  app: App,
): (path: string, stream: ReadableStream<Uint8Array>, options: { agreed: string; vaultSha: string; size?: number }, commit?: CommitScope) => Promise<StreamReplaceResult> {
  const ports = obsidianStreamingPorts(app);
  return async (path, stream, options, commit) => {
    if (!isVaultTarget(path, configDirOf(app))) {
      await stream.cancel().catch(() => undefined);
      return { outcome: "skipped" };
    }
    return replaceBinaryFromStream(ports, path, stream, options, MAX_ATTACHMENT_BYTES, commit);
  };
}
