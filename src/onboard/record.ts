import type { LocalState } from "../disk/bases";
import { isRepoName } from "../mapping";

const KEY = "specgit-vault-upload";

const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export interface UploadRecord {
  repo: string;
  at: number;
  uploaded?: true;
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
      const value = kept as { repo?: unknown; at?: unknown; uploaded?: unknown };
      if (typeof value.repo === "string" && isRepoName(value.repo) && typeof value.at === "number" && this.now() - value.at <= KEPT_MS && (value.uploaded === undefined || value.uploaded === true))
        return { repo: value.repo, at: value.at, ...(value.uploaded === true ? { uploaded: true as const } : {}) };
      this.state.save(KEY, null);
    } catch { /* empty */ }
    return null;
  }

  write(repo: string): void {
    try {
      this.state.save(KEY, { repo, at: this.now() });
    } catch { /* empty */ }
  }

  markUploaded(): void {
    const kept = this.read();
    if (kept === null) return;
    try {
      this.state.save(KEY, { ...kept, uploaded: true });
    } catch { /* empty */ }
  }

  clear(): void {
    try {
      this.state.save(KEY, null);
    } catch { /* empty */ }
  }
}
