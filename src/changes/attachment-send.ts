import type { DocumentRef } from "../mapping";
import type { ReviewApi, StepResult } from "../review/review-api";
import { ATTACHMENT_WORDS, JSON_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES, TRY_AGAIN } from "../shared/review-flow";
import { gitBlobSha, gitBlobShaOfStream } from "./blob-sha";

export const ATTACHMENT_REQUEST_BYTES = 4 * 1024 * 1024;

export const INLINE_ATTACHMENT_MAX_RAW = Math.floor((ATTACHMENT_REQUEST_BYTES * 3) / 4);

export const BURST_ATTACHMENT_MAX_RAW = 6 * 1024 * 1024;

export interface NamedAttachment {
  repoPath: string;
  base64?: string;
  binary?: () => Promise<Blob | Uint8Array>;
  sha: string;
  size: number;
  expectSha?: string | null;
}

const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  const buf = typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : await new Response(blob).arrayBuffer();
  return new Uint8Array(buf);
}

export async function nameAttachments(attachments: readonly { repoPath: string; base64: string }[]): Promise<NamedAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      const bytes = bytesOf(attachment.base64);
      return { ...attachment, sha: await gitBlobSha(bytes), size: bytes.length };
    }),
  );
}

export const attachmentEntry = (attachment: NamedAttachment, carry: boolean) => ({
  filePath: attachment.repoPath,
  sha: attachment.sha,
  size: attachment.size,
  ...(carry && attachment.base64 !== undefined ? { base64: attachment.base64 } : {}),
  ...(attachment.expectSha === undefined ? {} : { expectSha: attachment.expectSha }),
});

export function attachmentsToCarry(attachments: readonly NamedAttachment[], budget = ATTACHMENT_REQUEST_BYTES): Set<NamedAttachment> {
  const carried = new Set<NamedAttachment>();
  let bytes = 0;
  for (const attachment of attachments) {
    if (attachment.base64 === undefined) continue;
    if (bytes + attachment.base64.length > budget) continue;
    carried.add(attachment);
    bytes += attachment.base64.length;
  }
  return carried;
}

export type AttachmentUploader = Pick<ReviewApi, "attachment"> & Partial<Pick<ReviewApi, "canUploadBinary" | "uploadAttachment">>;

const UNREADABLE_WORDS = "That file couldn't be read from your vault.";

export async function uploadOneAttachment(
  review: AttachmentUploader,
  doc: DocumentRef,
  attachment: NamedAttachment,
): Promise<{ result: StepResult; sha: string }> {
  const tooLarge = (): { result: StepResult; sha: string } => ({
    result: { ok: false, status: 413, code: "too_large", message: ATTACHMENT_WORDS.tooLarge, body: null },
    sha: attachment.sha,
  });
  const unreadable = (): { result: StepResult; sha: string } => ({
    result: { ok: false, status: 0, code: "unreadable", message: UNREADABLE_WORDS, body: null },
    sha: attachment.sha,
  });

  if (attachment.binary && review.canUploadBinary === true && review.uploadAttachment) {
    let body: Blob | Uint8Array;
    let bodySize: number;
    let sha: string;
    try {
      body = await attachment.binary();
      bodySize = body instanceof Blob ? body.size : body.byteLength;
      if (bodySize > MAX_ATTACHMENT_BYTES) return tooLarge();
      sha =
        bodySize !== attachment.size
          ? body instanceof Blob
            ? typeof body.stream === "function"
              ? await gitBlobShaOfStream(body.size, body.stream())
              : await gitBlobSha(await blobBytes(body))
            : await gitBlobSha(body)
          : attachment.sha;
    } catch {
      return unreadable();
    }
    const uploaded = await review.uploadAttachment(doc, {
      filePath: attachment.repoPath,
      blobSha: sha,
      body,
      ...(attachment.expectSha === undefined ? {} : { expectSha: attachment.expectSha }),
    });
    if (
      !uploaded.ok &&
      (uploaded.status === 404 || uploaded.status === 405 || uploaded.status === 501) &&
      bodySize <= JSON_ATTACHMENT_MAX_BYTES
    ) {
      try {
        const raw = body instanceof Blob ? await blobBytes(body) : body;
        const fallback = await review.attachment(doc, attachment.repoPath, bytesToBase64(raw), attachment.expectSha);
        return { result: fallback, sha };
      } catch {
        return unreadable();
      }
    }
    return { result: uploaded, sha };
  }

  if (attachment.size > JSON_ATTACHMENT_MAX_BYTES) return tooLarge();
  let base64 = attachment.base64;
  let sha = attachment.sha;
  if (base64 === undefined) {
    if (!attachment.binary) {
      return { result: { ok: false, status: 501, code: "unsupported", message: TRY_AGAIN, body: null }, sha };
    }
    try {
      const body = await attachment.binary();
      const bodySize = body instanceof Blob ? body.size : body.byteLength;
      if (bodySize > JSON_ATTACHMENT_MAX_BYTES) return tooLarge();
      const raw = body instanceof Blob ? await blobBytes(body) : body;
      if (bodySize !== attachment.size) sha = await gitBlobSha(raw);
      base64 = bytesToBase64(raw);
    } catch {
      return unreadable();
    }
  }
  const uploaded = await review.attachment(doc, attachment.repoPath, base64, attachment.expectSha);
  return { result: uploaded, sha };
}

export function attachmentAnswer(body: Record<string, unknown>): { written: Set<string>; held: Set<string>; needed: Set<string>; refused: Map<string, "exists" | "changed"> } | null {
  const said = body.attachments as { written?: unknown; held?: unknown; needed?: unknown; refused?: unknown } | undefined;
  if (typeof said !== "object" || said === null) return null;
  const paths = (value: unknown): Set<string> => new Set(Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);
  const refused = new Map<string, "exists" | "changed">();
  if (Array.isArray(said.refused)) for (const one of said.refused as Array<{ path?: unknown; why?: unknown }>) if (typeof one?.path === "string" && (one.why === "exists" || one.why === "changed")) refused.set(one.path, one.why);
  return { written: paths(said.written), held: paths(said.held), needed: paths(said.needed), refused };
}
