import {
  VAULT_FILE_MAX_BYTES,
  VAULT_PACK_MAX_BYTES,
  VAULT_PACK_MAX_FILES,
  VAULT_PACK_MAX_META_BYTES,
  VAULT_PART_MAX_BYTES,
  VAULT_PART_MAX_FILES,
} from "../shared/review-flow";

export function safeRepoName(typed: string): string | null {
  const name = typed.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
  return name === "" || name === "." || name === ".." ? null : name;
}

const NOT_SENT = new Set(["thumbs.db", "desktop.ini"]);

export function planRule(path: string, configDir: string): boolean {
  const config = `${configDir}/`;
  if (path.startsWith(config)) {
    const rest = path.slice(config.length);
    if (rest.startsWith("themes/") || rest.startsWith("snippets/")) return true;
    return !rest.includes("/") && rest.endsWith(".json") && rest !== "workspace.json" && rest !== "workspace-mobile.json";
  }
  if (path === ".gitignore") return true;
  if (path.startsWith(".")) return false;
  return !NOT_SENT.has((path.split("/").pop() ?? "").toLowerCase());
}

export function gitignoreText(configDir: string): string {
  return [
    "# Written by specgit when this vault was put on GitHub.",
    "# Obsidian's window layout, which changes on every device",
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`,
    "# Community plugins: Obsidian installs them again from community-plugins.json,",
    "# and their settings can hold passwords and keys",
    `${configDir}/plugins/`,
    "# Obsidian's trash",
    ".trash/",
    "# Files your computer makes",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "",
  ].join("\n");
}

export function sendAs(path: string, bytes: Uint8Array, configDir: string): "text" | "base64" {
  const inConfig = path.startsWith(`${configDir}/`);
  const written = /\.(md|canvas|base)$/.test(path) || (inConfig && /\.(json|css)$/.test(path)) || path === ".gitignore";
  if (!written) return "base64";
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return "text";
  } catch {
    return "base64";
  }
}

const UTF8 = new TextEncoder();
const PACK_META_ENVELOPE_BYTES = 512;
const PACK_META_ENTRY_OVERHEAD_BYTES = 96;

const estimatePackEntryMetaBytes = (path: string): number => UTF8.encode(JSON.stringify(path)).byteLength + PACK_META_ENTRY_OVERHEAD_BYTES;

function chunkParts<T extends { path: string }>(
  files: readonly T[],
  costOf: (file: T) => number,
  maxFiles: number,
  maxBudget: number,
  maxMetaBytes?: number,
): string[][] {
  const parts: string[][] = [];
  let part: string[] = [];
  let budget = 0;
  let metaBytes = PACK_META_ENVELOPE_BYTES;
  for (const file of files) {
    const cost = costOf(file);
    const entryMeta = maxMetaBytes === undefined ? 0 : estimatePackEntryMetaBytes(file.path);
    const overMeta = maxMetaBytes !== undefined && metaBytes + entryMeta > maxMetaBytes;
    if (part.length > 0 && (part.length + 1 > maxFiles || budget + cost > maxBudget || overMeta)) {
      parts.push(part);
      part = [];
      budget = 0;
      metaBytes = PACK_META_ENVELOPE_BYTES;
    }
    part.push(file.path);
    budget += cost;
    metaBytes += entryMeta;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

export function packParts(files: ReadonlyArray<{ path: string; weight: number }>): string[][] {
  return chunkParts(files, (file) => file.weight, VAULT_PART_MAX_FILES, VAULT_PART_MAX_BYTES);
}

export function packBinaryParts(files: ReadonlyArray<{ path: string; size: number }>): string[][] {
  return chunkParts(files, (file) => file.size, VAULT_PACK_MAX_FILES, VAULT_PACK_MAX_BYTES, VAULT_PACK_MAX_META_BYTES);
}

export interface VaultPlan {
  files: Array<{ path: string; size: number }>;
  tooLarge: string[];
  notes: number;
  others: number;
  othersAndNotesBytes: number;
  totalBytes: number;
  gitignore: string;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function planVault(listed: ReadonlyArray<{ path: string; size: number }>, config: ReadonlyArray<{ path: string; size: number }>, configDir: string, ownGitignore: string | null): VaultPlan {
  const gitignore = ownGitignore ?? gitignoreText(configDir);
  const files: VaultPlan["files"] = [];
  const tooLarge: string[] = [];
  let notes = 0;
  let others = 0;
  let othersAndNotesBytes = 0;
  const keep = (file: { path: string; size: number }, counted: boolean): void => {
    if (file.path === ".gitignore" || !planRule(file.path, configDir)) return;
    if (file.size > VAULT_FILE_MAX_BYTES) return void tooLarge.push(file.path);
    files.push(file);
    if (!counted) return;
    othersAndNotesBytes += file.size;
    if (file.path.endsWith(".md")) notes++;
    else others++;
  };
  for (const file of listed) keep(file, true);
  for (const file of config) keep(file, false);
  files.push({ path: ".gitignore", size: new TextEncoder().encode(gitignore).length });
  files.sort((a, b) => byCodePoint(a.path, b.path));
  tooLarge.sort(byCodePoint);
  return { files, tooLarge, notes, others, othersAndNotesBytes, totalBytes: files.reduce((sum, file) => sum + file.size, 0), gitignore };
}
