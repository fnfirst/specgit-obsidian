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

  async bring(ports: BringPorts, memory: AttachmentMemory | undefined, branch: string, notePath: string, text: string, said: (words: string | null) => void, options: { replace?: boolean } = {}): Promise<void> {
    const links = fileAttachmentLinks(notePath, text);
    const now = ports.now();
    const embeds = links.join("\n");
    const before = this.looked.get(notePath);
    const recheck = before === undefined || before.embeds !== embeds || now - before.at > ATTACHMENT_RECHECK_MS;
    if (recheck) this.looked.set(notePath, { at: now, embeds });
    let both: string | null = null;
    let outside = false;
    for (const link of links) {
      const here = ports.resolve(link, notePath);
      if (here !== null) {
        if (options.replace !== true) continue;
        const repoPath = recheck && memory ? ports.repoPathOf(here.path) : null;
        const agreed = repoPath === null ? undefined : memory!.agreedOf(repoPath);
        if (repoPath === null || agreed === undefined || here.size > MAX_ATTACHMENT_BYTES) continue;
        const read = await ports.draftAttachment(repoPath, agreed);
        if (read.kind === "unreadable" && read.outage === true) return;
        if (read.kind !== "bytes" && read.kind !== "stream") continue;
        let vaultSha: string;
        try {
          vaultSha = await ports.vaultSha(here);
        } catch (err) {
          await cancelIfStream(read);
          throw err;
        }
        const res = await landReplacement(ports, here.path, read, agreed, vaultSha);
        if (res.outcome === "outage") return;
        if (res.outcome === "replaced" || (res.outcome === "same" && res.sha !== agreed)) memory!.agree(repoPath, res.sha);
        else if (res.outcome === "both") both = ATTACHMENT_BOTH(attachmentName(repoPath));
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
              memory?.agree(read.path, made.sha);
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
