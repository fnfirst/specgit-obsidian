export const GROUP_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

export const GROUP_UPLOAD_MAX_FILES = 500;

export const BURST_RESEND_CODE = "group_not_current";

export type BurstLeftWhy = "review" | "main" | "grouped" | "same";

export interface BurstLeftOut {
  path: string;
  why: BurstLeftWhy;
  sha?: string;
}

export const RECORD_WRITES = 4;

export const burstWrites = (parts: number): number => 1 + parts + RECORD_WRITES * (parts + 1) + 1;

export const isBurstUnavailable = (answer: { status: number; code: string | null }): boolean => answer.code === "unavailable" || answer.code === "timeout" || (answer.status >= 502 && answer.status <= 504);

export interface BurstFile {
  path: string;
  content: string;
  from?: string;
  base?: string | null;
}

export const burstBytes = (files: readonly BurstFile[]): number => files.reduce((sum, file) => sum + utf8Bytes(file.content), 0);

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
