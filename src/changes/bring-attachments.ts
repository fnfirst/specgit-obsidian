import type { AttachmentFile } from "../auth/git-copy";
import { ATTACHMENT_WORDS, MAX_ATTACHMENT_BYTES } from "../shared/review-flow";
import { fileAttachmentLinks } from "./attachment-links";
import { ATTACHMENT_RECHECK_MS, ATTACHMENT_RETRY_MS, type AttachmentMemory, attachmentMove, attachmentName } from "./attachment-memory";
import { ATTACHMENT_BOTH } from "../stay/words";

export interface BringPorts {
  now(): number;
  resolve(link: string, notePath: string): { path: string; mtime: number; size: number } | null;
  repoPathOf(vaultPath: string): string | null;
  vaultPathOf(repoPath: string): string | null;
  findAttachment(link: string, notePath: string): Promise<AttachmentFile>;
  told(notePath: string, words: readonly string[]): void;
  draftAttachment(repoPath: string): Promise<AttachmentFile>;
  vaultSha(file: { path: string; mtime: number; size: number }): Promise<string>;
  shaOf(bytes: ArrayBuffer): Promise<string>;
  notWritten(path: string): void;
  during<T>(paths: string[], run: () => Promise<T>, left?: (result: T) => Readonly<Record<string, string>> | null): Promise<T>;
  replace(path: string, bytes: ArrayBuffer, expectedSha: string): Promise<boolean>;
  create(path: string, bytes: ArrayBuffer): Promise<"created" | "exists" | "failed">;
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
        const read = await ports.draftAttachment(repoPath);
        if (read.kind === "unreadable" && read.outage === true) return;
        if (read.kind !== "bytes") continue;
        const draftSha = await ports.shaOf(read.bytes);
        const vaultSha = await ports.vaultSha(here);
        const move = attachmentMove(vaultSha, agreed, draftSha);
        if (move === "take") {
          if (await ports.during([here.path], () => ports.replace(here.path, read.bytes, vaultSha))) memory!.agree(repoPath, draftSha);
          else ports.notWritten(here.path);
        } else if (move === "same") {
          if (draftSha !== agreed) memory!.agree(repoPath, draftSha);
        } else both = ATTACHMENT_BOTH(attachmentName(repoPath));
        continue;
      }
      const missKey = `${branch}\n${notePath}\n${link}`;
      if (now - (this.misses.get(missKey) ?? Number.NEGATIVE_INFINITY) < ATTACHMENT_RETRY_MS) continue;
      let found = false;
      const read = await ports.findAttachment(link, notePath);
      if (read.kind === "unreadable" && read.outage === true) return;
      if (read.kind === "bytes" && read.path !== undefined && read.bytes.byteLength <= MAX_ATTACHMENT_BYTES) {
        found = true;
        const make = ports.vaultPathOf(read.path);
        if (make === null) outside = true;
        else {
          const made = await ports.during([make], () => ports.create(make, read.bytes));
          if (made !== "created") ports.notWritten(make);
          if (made === "created") memory?.agree(read.path, await ports.shaOf(read.bytes));
          if (made === "failed") found = false;
        }
      }
      if (!found) this.misses.set(missKey, now);
    }
    ports.told(notePath, outside ? [ATTACHMENT_WORDS.outsideFolder] : []);
    said(both);
  }
}

export function draftElseMain(draft: (repoPath: string) => Promise<AttachmentFile>, main: (repoPath: string) => Promise<AttachmentFile>): (repoPath: string) => Promise<AttachmentFile> {
  return async (repoPath) => {
    const read = await draft(repoPath);
    return read.kind === "absent" ? main(repoPath) : read;
  };
}
