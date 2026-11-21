import { gitBlobSha } from "./blob-sha";

export const ATTACHMENT_REQUEST_BYTES = 4 * 1024 * 1024;

export interface NamedAttachment {
  repoPath: string;
  base64: string;
  sha: string;
  size: number;
  expectSha?: string | null;
}

const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

export async function nameAttachments(attachments: readonly { repoPath: string; base64: string }[]): Promise<NamedAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      const bytes = bytesOf(attachment.base64);
      return { ...attachment, sha: await gitBlobSha(bytes), size: bytes.length };
    }),
  );
}

export const attachmentEntry = (attachment: NamedAttachment, carry: boolean) => ({ filePath: attachment.repoPath, sha: attachment.sha, size: attachment.size, ...(carry ? { base64: attachment.base64 } : {}), ...(attachment.expectSha === undefined ? {} : { expectSha: attachment.expectSha }) });

export function attachmentsToCarry(attachments: readonly NamedAttachment[], budget = ATTACHMENT_REQUEST_BYTES): Set<NamedAttachment> {
  const carried = new Set<NamedAttachment>();
  let bytes = 0;
  for (const attachment of attachments) {
    if (bytes + attachment.base64.length > budget) continue;
    carried.add(attachment);
    bytes += attachment.base64.length;
  }
  return carried;
}

export function attachmentAnswer(body: Record<string, unknown>): { written: Set<string>; held: Set<string>; needed: Set<string>; refused: Map<string, "exists" | "changed"> } | null {
  const said = body.attachments as { written?: unknown; held?: unknown; needed?: unknown; refused?: unknown } | undefined;
  if (typeof said !== "object" || said === null) return null;
  const paths = (value: unknown): Set<string> => new Set(Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);
  const refused = new Map<string, "exists" | "changed">();
  if (Array.isArray(said.refused)) for (const one of said.refused as Array<{ path?: unknown; why?: unknown }>) if (typeof one?.path === "string" && (one.why === "exists" || one.why === "changed")) refused.set(one.path, one.why);
  return { written: paths(said.written), held: paths(said.held), needed: paths(said.needed), refused };
}
