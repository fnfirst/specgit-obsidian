import { NOTE_BRANCH } from "../auth/config";
import type { AttachmentFile } from "../auth/git-copy";
import type { CommitScope, StreamCreateResult, StreamReplaceResult } from "../disk/vault-binary";
import { isVaultTarget, normalizeFolder } from "../mapping";
import { ATTACHMENT_WORDS, MAX_ATTACHMENT_BYTES } from "../shared/review-flow";
import { fileAttachmentLinks } from "./attachment-links";
import { ATTACHMENT_RECHECK_MS, ATTACHMENT_RETRY_MS, type AttachmentMemory, attachmentMove, attachmentName } from "./attachment-memory";
import { readStreamBounded } from "./blob-sha";
import { ATTACHMENT_BOTH } from "../stay/words";

export type AttachmentPlacement = { kind: "target"; path: string } | { kind: "outside" } | { kind: "unsafe" };

export function attachmentPlace(folder: string, repoPath: string, configDir = ""): string | null {
  if (!isVaultTarget(repoPath)) return null;
  const top = normalizeFolder(folder);
  const target = top === "" ? repoPath : `${top}/${repoPath}`;
  return isVaultTarget(target, configDir) ? target : null;
}

export function attachmentPlacement(folder: string, repoPath: string, configDir = ""): AttachmentPlacement {
  const path = attachmentPlace(folder, repoPath, configDir);
  return path === null ? { kind: "unsafe" } : { kind: "target", path };
}

function normalizePlacement(raw: AttachmentPlacement | string | null, repoPath: string, configDir: string): AttachmentPlacement {
  if (raw === null) return isVaultTarget(repoPath, configDir) ? { kind: "outside" } : { kind: "unsafe" };
  if (typeof raw === "string") return { kind: "target", path: raw };
  return raw;
}

export interface BringPorts {
  configDir?: string;
  now(): number;
  resolve(link: string, notePath: string): { path: string; mtime: number; size: number } | null;
  repoPathOf(vaultPath: string): string | null;
  vaultPathOf(repoPath: string): AttachmentPlacement | string | null;
  findAttachment(link: string, notePath: string): Promise<AttachmentFile>;
  told(notePath: string, words: readonly string[]): void;
  draftAttachment(repoPath: string, ifNoneMatch?: string): Promise<AttachmentFile>;
  vaultSha(file: { path: string; mtime: number; size: number }): Promise<string>;
  shaOf(bytes: ArrayBuffer): Promise<string>;
  notWritten(path: string): void;
  during<T>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null): Promise<T>;
  replace(path: string, bytes: ArrayBuffer, expectedSha: string): Promise<boolean>;
  create(path: string, bytes: ArrayBuffer): Promise<"created" | "exists" | "failed">;
  createStream?(path: string, stream: ReadableStream<Uint8Array>, size?: number, commit?: CommitScope): Promise<StreamCreateResult>;
  replaceStream?(path: string, stream: ReadableStream<Uint8Array>, options: { agreed: string; vaultSha: string; size?: number }, commit?: CommitScope): Promise<StreamReplaceResult>;
  branchActive?(branch: string): boolean;
  publishedSha?(vaultPath: string): string | null | undefined;
}

export function draftSourceOf(branch: string): string | undefined {
  return branch === NOTE_BRANCH ? undefined : branch;
}

export function branchBeatsOwner(incoming: string, owner: string): boolean {
  return incoming !== NOTE_BRANCH && incoming < owner;
}

function ownerForSha(sha: string, source: string | undefined, published: string | null | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (published !== undefined && published !== null && sha === published) return undefined;
  return source;
}

function canClaimUpgradeOwner(sha: string, published: string | null | undefined): boolean {
  return published === null || (published !== undefined && sha !== published);
}

async function resolveDraftSha(
  ports: BringPorts,
  read: ReadableAttachment,
): Promise<{ kind: "sha"; sha: string; read: ReadableAttachment } | { kind: "outage" } | { kind: "skipped" }> {
  if (read.kind === "stream" && read.size !== undefined && read.size > MAX_ATTACHMENT_BYTES) {
    await cancelIfStream(read);
    return { kind: "skipped" };
  }
  if (read.sha !== undefined) return { kind: "sha", sha: read.sha, read };
  if (read.kind === "bytes") return { kind: "sha", sha: await ports.shaOf(read.bytes), read };
  const got = await readStreamBounded(read.stream, MAX_ATTACHMENT_BYTES, read.size);
  if (!got.ok) return { kind: got.outage ? "outage" : "skipped" };
  const sha = await ports.shaOf(got.bytes);
  return { kind: "sha", sha, read: { kind: "bytes", bytes: got.bytes, sha } };
}

type ReadableAttachment = Extract<AttachmentFile, { kind: "bytes" | "stream" }>;

const cancelIfStream = (read: AttachmentFile): Promise<void> => (read.kind === "stream" ? read.stream.cancel().catch(() => undefined) : Promise.resolve());

async function landNewAttachment(ports: BringPorts, path: string, read: ReadableAttachment): Promise<StreamCreateResult> {
  let entered = false;
  const commit: CommitScope = (run) => {
    entered = true;
    return ports.during([path], run);
  };
  const finish = (outcome: StreamCreateResult): StreamCreateResult => {
    if (outcome.status !== "created" && entered) ports.notWritten(path);
    return outcome;
  };
  if (read.kind === "stream" && ports.createStream) {
    return finish(await ports.createStream(path, read.stream, read.size, commit));
  }
  let bytes: ArrayBuffer;
  if (read.kind === "bytes") {
    bytes = read.bytes;
  } else {
    const got = await readStreamBounded(read.stream, MAX_ATTACHMENT_BYTES, read.size);
    if (!got.ok) return { status: got.outage ? "outage" : "failed" };
    bytes = got.bytes;
  }
  const made = await commit(() => ports.create(path, bytes));
  return finish(made === "created" ? { status: "created", sha: await ports.shaOf(bytes) } : { status: made });
}

async function landReplacement(
  ports: BringPorts,
  path: string,
  read: ReadableAttachment,
  agreed: string,
  vaultSha: string,
): Promise<StreamReplaceResult> {
  if (read.kind === "stream" && read.size !== undefined && read.size > MAX_ATTACHMENT_BYTES) {
    await cancelIfStream(read);
    return { outcome: "skipped" };
  }
  if (read.sha !== undefined) {
    const early = attachmentMove(vaultSha, agreed, read.sha);
    if (early === "same") {
      await cancelIfStream(read);
      return { outcome: "same", sha: read.sha };
    }
    if (early === "both") {
      await cancelIfStream(read);
      return { outcome: "both" };
    }
  }
  let entered = false;
  const commit: CommitScope = (run) => {
    entered = true;
    return ports.during([path], run);
  };
  const finish = (outcome: StreamReplaceResult): StreamReplaceResult => {
    if (outcome.outcome !== "replaced" && entered) ports.notWritten(path);
    return outcome;
  };
  if (read.kind === "stream" && ports.replaceStream) {
    return finish(await ports.replaceStream(path, read.stream, { agreed, vaultSha, ...(read.size === undefined ? {} : { size: read.size }) }, commit));
  }
  let bytes: ArrayBuffer;
  if (read.kind === "bytes") {
    bytes = read.bytes;
  } else {
    const got = await readStreamBounded(read.stream, MAX_ATTACHMENT_BYTES, read.size);
    if (!got.ok) return { outcome: got.outage ? "outage" : "skipped" };
    bytes = got.bytes;
  }
  const draftSha = await ports.shaOf(bytes);
  const move = attachmentMove(vaultSha, agreed, draftSha);
  if (move === "same") return { outcome: "same", sha: draftSha };
  if (move === "both") return { outcome: "both" };
  return finish((await commit(() => ports.replace(path, bytes, vaultSha))) ? { outcome: "replaced", sha: draftSha } : { outcome: "skipped" });
}

export class AttachmentLooks {
  private readonly misses = new Map<string, number>();
  private readonly looked = new Map<string, { at: number; embeds: string }>();
  private readonly inflight = new Map<string, Promise<void>>();

  private async exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = this.inflight.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => mine);
    this.inflight.set(key, tail);
    await prior;
    try {
      return await run();
    } finally {
      release();
      if (this.inflight.get(key) === tail) this.inflight.delete(key);
    }
  }

  async bring(ports: BringPorts, memory: AttachmentMemory | undefined, branch: string, notePath: string, text: string, said: (words: string | null) => void, options: { replace?: boolean } = {}): Promise<void> {
    const links = fileAttachmentLinks(notePath, text);
    const now = ports.now();
    const embeds = links.join("\n");
    const before = this.looked.get(notePath);
    const recheck = before === undefined || before.embeds !== embeds || now - before.at > ATTACHMENT_RECHECK_MS;
    if (recheck) this.looked.set(notePath, { at: now, embeds });
    let both: string | null = null;
    let outside = false;
    const source = draftSourceOf(branch);
    for (const link of links) {
      const here = ports.resolve(link, notePath);
      if (here !== null) {
        if (options.replace !== true) continue;
        const repoPath = recheck && memory ? ports.repoPathOf(here.path) : null;
        if (repoPath === null || here.size > MAX_ATTACHMENT_BYTES) continue;
        const outcome = await this.exclusive(repoPath, async (): Promise<"ok" | "outage"> => {
          const agreed = memory!.agreedOf(repoPath);
          if (agreed === undefined) return "ok";
          const owner = memory!.sourceOf(repoPath);
          const ownerActive = owner !== undefined && (ports.branchActive ? ports.branchActive(owner) : true);
          if (ownerActive && owner !== branch && branch === NOTE_BRANCH) return "ok";
          const read = await ports.draftAttachment(repoPath, agreed);
          if (read.kind === "unreadable" && read.outage === true) return "outage";
          const published = ports.publishedSha?.(here.path);
          if (read.kind === "unchanged") {
            if (owner === undefined && source !== undefined && canClaimUpgradeOwner(agreed, published)) memory!.agree(repoPath, agreed, source);
            return "ok";
          }
          if (read.kind !== "bytes" && read.kind !== "stream") return "ok";
          let vaultSha: string;
          try {
            vaultSha = await ports.vaultSha(here);
          } catch (err) {
            await cancelIfStream(read);
            throw err;
          }
          if (ownerActive && owner !== branch) {
            const resolved = await resolveDraftSha(ports, read);
            if (resolved.kind === "outage") return "outage";
            if (resolved.kind === "skipped") return "ok";
            if (resolved.sha === vaultSha || resolved.sha === agreed) {
              await cancelIfStream(resolved.read);
              return "ok";
            }
            if (published !== undefined && published !== null && resolved.sha === published && vaultSha !== published) {
              await cancelIfStream(resolved.read);
              return "ok";
            }
            const beatsMainBaseline = published !== undefined && published !== null && vaultSha === published && resolved.sha !== published;
            if (!beatsMainBaseline && !branchBeatsOwner(branch, owner)) {
              await cancelIfStream(resolved.read);
              both = ATTACHMENT_BOTH(attachmentName(repoPath));
              return "ok";
            }
            const res = await landReplacement(ports, here.path, resolved.read, agreed, vaultSha);
            if (res.outcome === "outage") return "outage";
            if (res.outcome === "replaced" || (res.outcome === "same" && res.sha !== agreed)) memory!.agree(repoPath, res.sha, ownerForSha(res.sha, source, published));
            else if (res.outcome === "both") both = ATTACHMENT_BOTH(attachmentName(repoPath));
            return "ok";
          }
          const res = await landReplacement(ports, here.path, read, agreed, vaultSha);
          if (res.outcome === "outage") return "outage";
          if (res.outcome === "replaced" || (res.outcome === "same" && res.sha !== agreed)) memory!.agree(repoPath, res.sha, ownerForSha(res.sha, source, published));
          else if (res.outcome === "same" && owner === undefined && source !== undefined && canClaimUpgradeOwner(res.sha, published)) memory!.agree(repoPath, res.sha, source);
          else if (res.outcome === "both") both = ATTACHMENT_BOTH(attachmentName(repoPath));
          return "ok";
        });
        if (outcome === "outage") return;
        continue;
      }
      const missKey = `${branch}\n${notePath}\n${link}`;
      if (now - (this.misses.get(missKey) ?? Number.NEGATIVE_INFINITY) < ATTACHMENT_RETRY_MS) continue;
      let found = false;
      const read = await ports.findAttachment(link, notePath);
      if (read.kind === "unreadable" && read.outage === true) return;
      if (read.kind === "bytes" || read.kind === "stream") {
        const size = read.kind === "stream" ? read.size : read.bytes.byteLength;
        if (read.path === undefined || (size !== undefined && size > MAX_ATTACHMENT_BYTES)) {
          await cancelIfStream(read);
        } else if (!isVaultTarget(read.path)) {
          await cancelIfStream(read);
        } else {
          const configDir = ports.configDir ?? "";
          const placed = normalizePlacement(ports.vaultPathOf(read.path), read.path, configDir);
          if (placed.kind === "unsafe") {
            await cancelIfStream(read);
          } else if (placed.kind === "outside") {
            await cancelIfStream(read);
            found = true;
            outside = true;
          } else if (!isVaultTarget(placed.path, configDir)) {
            await cancelIfStream(read);
          } else {
            const made = await landNewAttachment(ports, placed.path, read);
            if (made.status === "outage") return;
            if (made.status === "created") {
              found = true;
              const published = ports.publishedSha?.(placed.path);
              memory?.agree(read.path, made.sha, ownerForSha(made.sha, source, published));
            } else if (made.status === "exists") {
              found = true;
            }
          }
        }
      }
      if (!found) this.misses.set(missKey, now);
    }
    ports.told(notePath, outside ? [ATTACHMENT_WORDS.outsideFolder] : []);
    said(both);
  }
}

export function draftElseMain(
  draft: (repoPath: string, ifNoneMatch?: string) => Promise<AttachmentFile>,
  main: (repoPath: string, ifNoneMatch?: string) => Promise<AttachmentFile>,
): (repoPath: string, ifNoneMatch?: string) => Promise<AttachmentFile> {
  return async (repoPath, ifNoneMatch) => {
    const read = await draft(repoPath, ifNoneMatch);
    return read.kind === "absent" ? main(repoPath, ifNoneMatch) : read;
  };
}
