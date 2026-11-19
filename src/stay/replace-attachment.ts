import { gitBlobSha } from "../changes/blob-sha";

export interface AttachmentVault<File> {
  getFileByPath(path: string): File | null;
  readBinary(file: File): Promise<ArrayBuffer>;
  modifyBinary(file: File, bytes: ArrayBuffer): Promise<void>;
}

export async function replaceAttachment<File>(vault: AttachmentVault<File>, path: string, bytes: ArrayBuffer, expectedSha: string, shaOf: (bytes: ArrayBuffer) => Promise<string> = gitBlobSha): Promise<boolean> {
  const target = vault.getFileByPath(path);
  if (!target) return false;
  if ((await shaOf(await vault.readBinary(target))) !== expectedSha) return false;
  await vault.modifyBinary(target, bytes);
  return true;
}
