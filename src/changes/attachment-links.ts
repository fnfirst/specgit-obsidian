import { isAttachmentPath } from "../shared/review-flow";

export const ATTACHMENT_LINK = /!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export const linkOf = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
};

export function attachmentLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(ATTACHMENT_LINK)) {
    const link = linkOf((match[1] ?? match[2] ?? "").trim());
    if (link !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(link) && isAttachmentPath(link)) found.add(link);
  }
  return [...found];
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
