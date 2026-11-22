export type AttachmentKind = "image" | "audio" | "video" | "pdf" | "file";

export const MAX_ATTACHMENT_BYTES = 100_000_000;

export const JSON_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const SHOWN: Readonly<Record<string, { kind: Exclude<AttachmentKind, "file">; mime: string }>> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  avif: { kind: "image", mime: "image/avif" },
  bmp: { kind: "image", mime: "image/bmp" },
  svg: { kind: "image", mime: "image/svg+xml" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  flac: { kind: "audio", mime: "audio/flac" },
  "3gp": { kind: "audio", mime: "audio/3gpp" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
  mov: { kind: "video", mime: "video/quicktime" },
  ogv: { kind: "video", mime: "video/ogg" },
  pdf: { kind: "pdf", mime: "application/pdf" },
};

const NOTES = new Set(["md", "canvas", "base"]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isAttachmentPath(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== "" && !NOTES.has(ext);
}

export function attachmentType(path: string): { kind: AttachmentKind; mime: string } | null {
  if (!isAttachmentPath(path)) return null;
  return SHOWN[extensionOf(path)] ?? { kind: "file", mime: "application/octet-stream" };
}

export function isEmbeddableMediaKind(kind: AttachmentKind): boolean {
  return kind === "image" || kind === "audio" || kind === "video";
}

export const ATTACHMENT_WORDS = {
  tooLarge: "Uses a file over 100 MB, not sent.",
  outsideFolder: "Uses a file outside the linked folder.",
  notMine: "Uses a file from your vault that isn't on GitHub yet.",
} as const;
