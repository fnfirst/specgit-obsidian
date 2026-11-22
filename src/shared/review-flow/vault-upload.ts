import { MAX_ATTACHMENT_BYTES } from "./attachments";

export const VAULT_PART_MAX_FILES = 300;
export const VAULT_PART_MAX_BYTES = 6 * 1024 * 1024;
export const VAULT_PACK_MAX_FILES = 500;
export const VAULT_PACK_MAX_BYTES = 32 * 1024 * 1024;
export const VAULT_PACK_MAX_META_BYTES = 1_048_576;
export const VAULT_FILE_MAX_BYTES = MAX_ATTACHMENT_BYTES;
export const VAULT_MAX_TOTAL_BYTES = 5_000_000_000;
export const VAULT_MAX_FILES = 100_000;
export const GITHUB_TEMPLATE_FILES: readonly string[] = ["README.md", "LICENSE", ".gitignore"];

export type VaultFile = { path: string; text: string } | { path: string; base64: string } | { path: string; delete: true };

export type VaultPackEntry = { path: string; size: number; blobSha: string } | { path: string; delete: true };

export interface VaultPackMeta {
  repo: string;
  workHead: string;
  files: readonly VaultPackEntry[];
}

export type VaultFileKind = "text" | "base64" | "delete";

export function vaultWeight(kind: VaultFileKind, bytes: number): number {
  if (kind === "delete") return 0;
  return kind === "text" ? bytes : 4 * Math.ceil(bytes / 3);
}

export type VaultNextStep = "create" | "install" | "accept" | "form";
