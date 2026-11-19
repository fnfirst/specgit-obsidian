export const RENAME_LOOKS_AFTER_MS = 3_000;

export interface AttachmentRenamePorts {

  resolved(): Readonly<Record<string, Readonly<Record<string, number>>>>;

  isLive(path: string): boolean;

  live(path: string): void;

  local(path: string): void;
}

export function notesLinkingTo(resolved: Readonly<Record<string, Readonly<Record<string, number>>>>, target: string): string[] {
  return Object.keys(resolved).filter((note) => /\.md$/i.test(note) && (resolved[note]?.[target] ?? 0) > 0);
}

export function attachmentRenamed(ports: AttachmentRenamePorts, to: string): string[] {
  const notes = notesLinkingTo(ports.resolved(), to);
  for (const note of notes) {
    if (ports.isLive(note)) ports.live(note);
    else ports.local(note);
  }
  return notes;
}
