import { isAttachmentPath, MAX_ATTACHMENT_BYTES } from "../shared/review-flow";
import { attachmentLinks } from "./attachment-links";
import type { Attachment } from "./attachment-memory";

export interface CollectPorts {

  resolve(link: string, notePath: string): { path: string; mtime: number; size: number } | null;

  repoPathOf(vaultPath: string): string | null;

  sha(file: { path: string; mtime: number; size: number }): Promise<string>;

  base64(file: { path: string }): Promise<string>;

  agreedOf(repoPath: string): string | undefined;

  publishedSha(vaultPath: string): string | null | undefined;
}

export async function collectAttachments(ports: CollectPorts, notePath: string, text: string): Promise<Attachment[]> {
  const found = new Map<string, Attachment>();
  for (const link of attachmentLinks(text)) {
    const target = ports.resolve(link, notePath);
    if (!target || !isAttachmentPath(target.path) || found.has(target.path)) continue;
    const repoPath = ports.repoPathOf(target.path);
    if (repoPath === null) {
      found.set(target.path, { repoPath: target.path, skipped: "outsideFolder" });
      continue;
    }
    if (target.size > MAX_ATTACHMENT_BYTES) {
      found.set(target.path, { repoPath, skipped: "tooLarge" });
      continue;
    }
    const sha = await ports.sha(target);

    const expectSha = ports.agreedOf(repoPath) ?? ports.publishedSha(target.path);
    found.set(target.path, { repoPath, sha, base64: () => ports.base64(target), ...(expectSha === undefined ? {} : { expectSha }) });
  }
  return [...found.values()];
}
