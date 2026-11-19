import type { LocalState } from "../disk/bases";
import { hashText } from "../hash";
import { ATTACHMENT_WORDS } from "../shared/review-flow";

export type Attachment =
  | {
      repoPath: string;

      base64: string | (() => Promise<string>);

      sha?: string;

      expectSha?: string | null;
    }
  | { repoPath: string; skipped: "tooLarge" | "outsideFolder" };

export const ATTACHMENT_LATER = "it could not be sent just now, and specgit will try again shortly";

export const ATTACHMENT_NOT_SENT = "It could not be sent.";

export const ATTACHMENT_HELD = "it could not be sent after a few tries, and will be tried again when this note is next saved";

export const attachmentName = (repoPath: string): string => repoPath.split("/").pop() ?? repoPath;

export const ATTACHMENTS_KEPT = 500;

export class AttachmentMemory {
  private readonly key: string;
  private base: Record<string, string>;

  private readonly hashes = new Map<string, { mtime: number; size: number; sha: string }>();

  constructor(
    place: string,
    private readonly state: LocalState,
  ) {
    this.key = `specgit-attachments-${hashText(place)}`;
    const stored = (() => {
      try {
        return this.state.load(this.key);
      } catch {
        return null;
      }
    })();
    this.base = typeof stored === "object" && stored !== null && !Array.isArray(stored) && Object.values(stored).every((sha) => typeof sha === "string") ? { ...(stored as Record<string, string>) } : {};
  }

  agreedOf(repoPath: string): string | undefined {
    const sha = this.base[repoPath];

    if (sha !== undefined) {
      delete this.base[repoPath];
      this.base[repoPath] = sha;
    }
    return sha;
  }

  agree(repoPath: string, sha: string): void {
    if (this.base[repoPath] === sha) {
      delete this.base[repoPath];
      this.base[repoPath] = sha;
      return;
    }
    delete this.base[repoPath];
    this.base[repoPath] = sha;
    const keys = Object.keys(this.base);
    if (keys.length > ATTACHMENTS_KEPT) for (const old of keys.slice(0, keys.length - ATTACHMENTS_KEPT)) delete this.base[old];
    try {
      this.state.save(this.key, this.base);
    } catch { /* empty */ }
  }

  async hash(path: string, stat: { mtime: number; size: number }, read: () => Promise<string>): Promise<string> {
    const known = this.hashes.get(path);
    if (known && known.mtime === stat.mtime && known.size === stat.size) return known.sha;
    const sha = await read();
    this.hashes.set(path, { ...stat, sha });
    return sha;
  }
}

export type AttachmentMove = "same" | "take" | "both";

export function attachmentMove(vault: string, agreed: string, draft: string): AttachmentMove {
  if (draft === agreed || vault === draft) return "same";
  return vault === agreed ? "take" : "both";
}

export const ATTACHMENT_RETRY_MS = 15 * 60_000;

export const ATTACHMENT_RECHECK_MS = 5 * 60_000;

export function toldOf(attachments: readonly Attachment[]): string[] {
  const kinds = new Set(attachments.flatMap((one) => ("skipped" in one ? [one.skipped] : [])));
  return (["tooLarge", "outsideFolder"] as const).filter((kind) => kinds.has(kind)).map((kind) => ATTACHMENT_WORDS[kind]);
}

export async function withBytes(attachments: readonly Attachment[]): Promise<{ attachments: Array<{ repoPath: string; base64: string }>; told: string[] }> {
  const read: Array<{ repoPath: string; base64: string }> = [];
  for (const attachment of attachments) if (!("skipped" in attachment)) read.push({ repoPath: attachment.repoPath, base64: typeof attachment.base64 === "string" ? attachment.base64 : await attachment.base64() });
  return { attachments: read, told: toldOf(attachments) };
}

export const ATTACHMENTS_SAID = (problems: ReadonlyArray<{ name: string; why: string; server?: true }>): string => {
  const sentence = (why: string): string => (/[.!?]$/.test(why) ? why : `${why}.`);

  const one = (problem: { name: string; why: string; server?: true }): string => (problem.server === true ? `${problem.name}. ${sentence(problem.why)}` : `${problem.name}: ${sentence(problem.why)}`);
  return problems.length === 1 ? `specgit saved this note, but not its file ${one(problems[0]!)}` : `specgit saved this note, but not its files. ${problems.map(one).join(" ")}`;
};
