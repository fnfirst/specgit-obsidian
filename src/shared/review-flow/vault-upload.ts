import { MAX_ATTACHMENT_BYTES } from "./attachments";

export const VAULT_PART_MAX_FILES = 300;

export const VAULT_PART_MAX_BYTES = 6 * 1024 * 1024;

export const VAULT_FILE_MAX_BYTES = MAX_ATTACHMENT_BYTES;

export const VAULT_MAX_TOTAL_BYTES = 2 * 1024 ** 3;
export const VAULT_MAX_FILES = 100_000;

export const GITHUB_TEMPLATE_FILES: readonly string[] = ["README.md", "LICENSE", ".gitignore"];

export type VaultFile = { path: string; text: string } | { path: string; base64: string } | { path: string; delete: true };

export type VaultFileKind = "text" | "base64" | "delete";

export function vaultWeight(kind: VaultFileKind, bytes: number): number {
  if (kind === "delete") return 0;
  return kind === "text" ? bytes : 4 * Math.ceil(bytes / 3);
}

export type VaultNextStep = "create" | "install" | "accept" | "form";
