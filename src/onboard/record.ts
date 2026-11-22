import type { LocalState } from "../disk/bases";
import { isRepoName } from "../mapping";

const KEY = "specgit-vault-upload";

const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export interface UploadRecord {
  repo: string;
  at: number;
  uploaded?: true;
  private?: boolean;
}

export class UploadRecords {
  constructor(
    private readonly state: LocalState,
    private readonly now: () => number = Date.now,
  ) {}

  read(): UploadRecord | null {
    try {
      const kept = this.state.load(KEY);
      if (kept === null || kept === undefined) return null;
      const value = kept as { repo?: unknown; at?: unknown; uploaded?: unknown; private?: unknown };
      if (
        typeof value.repo === "string" &&
        isRepoName(value.repo) &&
        typeof value.at === "number" &&
        this.now() - value.at <= KEPT_MS &&
        (value.uploaded === undefined || value.uploaded === true) &&
        (value.private === undefined || typeof value.private === "boolean")
      ) {
        return {
          repo: value.repo,
          at: value.at,
          ...(value.uploaded === true ? { uploaded: true as const } : {}),
          ...(typeof value.private === "boolean" ? { private: value.private } : {}),
        };
      }
      this.state.save(KEY, null);
    } catch {
      void 0;
    }
    return null;
  }

  write(repo: string, isPrivate?: boolean): void {
    try {
      this.state.save(KEY, { repo, at: this.now(), ...(isPrivate === undefined ? {} : { private: isPrivate }) });
    } catch {
      void 0;
    }
  }

  markUploaded(): void {
    const kept = this.read();
    if (kept === null) return;
    try {
      this.state.save(KEY, { ...kept, uploaded: true });
    } catch {
      void 0;
    }
  }

  clear(): void {
    try {
      this.state.save(KEY, null);
    } catch {
      void 0;
    }
  }
}
