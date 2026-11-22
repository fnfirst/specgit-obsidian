import { isAttachmentPath, MAX_ATTACHMENT_BYTES } from "../shared/review-flow";
import { fileAttachmentLinks } from "./attachment-links";
import type { Attachment } from "./attachment-memory";

export interface CollectPorts {
  resolve(link: string, notePath: string): { path: string; mtime: number; size: number } | null;
  repoPathOf(vaultPath: string): string | null;
  sha(file: { path: string; mtime: number; size: number }): Promise<string>;
  base64(file: { path: string }): Promise<string>;
  binary?: (file: { path: string; size: number }) => Promise<Blob | Uint8Array>;
  agreedOf(repoPath: string): string | undefined;
  publishedSha(vaultPath: string): string | null | undefined;
  mine?: (link: string) => boolean;
}

export async function collectAttachments(ports: CollectPorts, notePath: string, text: string): Promise<Attachment[]> {
  const targets = new Map<string, { target: { path: string; mtime: number; size: number }; mine: boolean }>();
  for (const link of fileAttachmentLinks(notePath, text)) {
    const target = ports.resolve(link, notePath);
    if (!target || !isAttachmentPath(target.path)) continue;
    const isMine = ports.mine ? ports.mine(link) : true;
    const known = targets.get(target.path);
    if (known) {
      if (isMine) known.mine = true;
    } else {
      targets.set(target.path, { target, mine: isMine });
    }
  }
  const found: Attachment[] = [];
  for (const { target, mine } of targets.values()) {
    const repoPath = ports.repoPathOf(target.path);
    if (repoPath === null) {
      found.push({ repoPath: target.path, skipped: "outsideFolder" });
      continue;
    }
    const agreed = ports.agreedOf(repoPath);
    const published = ports.publishedSha(target.path);
    if (!mine && agreed === undefined && (published === undefined || published === null)) {
      found.push({ repoPath, skipped: "notMine" });
      continue;
    }
    if (target.size > MAX_ATTACHMENT_BYTES) {
      found.push({ repoPath, skipped: "tooLarge" });
      continue;
    }
    const sha = await ports.sha(target);
    const expectSha = agreed ?? published;
    found.push({
      repoPath,
      sha,
      size: target.size,
      base64: () => ports.base64(target),
      ...(ports.binary ? { binary: () => ports.binary!(target) } : {}),
      ...(expectSha === undefined ? {} : { expectSha }),
    });
  }
  return found;
}
