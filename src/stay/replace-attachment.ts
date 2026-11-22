import { gitBlobSha } from "../changes/blob-sha";
import { isVaultTarget } from "../mapping";

export interface AttachmentVault<File> {
  configDir?: string;
  getFileByPath(path: string): File | null;
  readBinary(file: File): Promise<ArrayBuffer>;
  modifyBinary(file: File, bytes: ArrayBuffer): Promise<void>;
}

export async function replaceAttachment<File>(vault: AttachmentVault<File>, path: string, bytes: ArrayBuffer, expectedSha: string, shaOf: (bytes: ArrayBuffer) => Promise<string> = gitBlobSha): Promise<boolean> {
  if (!isVaultTarget(path, vault.configDir)) return false;
  const target = vault.getFileByPath(path);
  if (!target) return false;
  if ((await shaOf(await vault.readBinary(target))) !== expectedSha) return false;
  await vault.modifyBinary(target, bytes);
  return true;
}
