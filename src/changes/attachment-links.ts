import { pathKind } from "../mapping";
import { isAttachmentPath } from "../shared/review-flow";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const ATTACHMENT_LINK = /!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!?\[[^\]]*\]\((?:<([^<>\n]+)>|([^<)\s][^)\s]*))(?:\s+"[^"]*")?\)/g;

const linkOf = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
};

function addAttachment(found: Set<string>, raw: string): void {
  const link = raw.trim().replace(/^(?:\.\/)+/, "");
  if (link !== "" && !SCHEME.test(link) && isAttachmentPath(link)) found.add(link);
}

function attachmentLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(ATTACHMENT_LINK)) {
    const raw = match[1] !== undefined ? match[1].trim().replace(/\\+$/, "").trim() : (match[2] ?? match[3] ?? "").trim();
    addAttachment(found, linkOf(raw));
  }
  return [...found];
}

function canvasAttachmentLinks(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const found = new Set<string>();
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const one = node as { type?: unknown; file?: unknown; background?: unknown; text?: unknown };
    if (one.type === "file" && typeof one.file === "string") addAttachment(found, one.file);
    else if (one.type === "group" && typeof one.background === "string") addAttachment(found, one.background);
    else if (one.type === "text" && typeof one.text === "string") {
      for (const link of attachmentLinks(one.text)) found.add(link);
    }
  }
  return [...found];
}

export const carriesAttachments = (path: string): boolean => {
  const kind = pathKind(path);
  return kind === "note" || kind === "board";
};

export function fileAttachmentLinks(path: string, text: string): string[] {
  const kind = pathKind(path);
  if (kind === "board") return canvasAttachmentLinks(text);
  if (kind === "note") return attachmentLinks(text);
  return [];
}

function joined(from: string, link: string): string | null {
  const out = from === "" ? [] : from.split("/");
  for (const part of link.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.pop() === undefined) return null;
    } else out.push(part);
  }
  return out.join("/");
}

export function attachmentTarget(link: string, notePath: string, paths: readonly string[], top = ""): string | null {
  if (!isAttachmentPath(link)) return null;
  const byLower = new Map(paths.map((path) => [path.toLowerCase(), path]));
  const folder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  const rooted = link.startsWith("/");
  for (const candidate of rooted ? [joined(top, link)] : [joined("", link), joined(folder, link)]) {
    const hit = candidate === null ? undefined : byLower.get(candidate.toLowerCase());
    if (hit !== undefined) return hit;
  }
  if (link.includes("/")) return null;
  const name = link.toLowerCase();
  const near = (path: string): number => (path.slice(0, path.lastIndexOf("/")).toLowerCase() === folder.toLowerCase() ? 0 : 1);
  const named = paths.filter((path) => (path.split("/").pop() ?? path).toLowerCase() === name).sort((a, b) => near(a) - near(b) || a.length - b.length || (a < b ? -1 : 1));
  return named[0] ?? null;
}
