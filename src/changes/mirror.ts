import type { LocalState } from "../disk/bases";
import { hashText } from "../hash";
import { splitRepo, type SpecgitApi } from "../api";
import { GIT_PROVIDER, NOTE_BRANCH } from "../auth/config";

export const ADDED_KEPT = 2_000;

export interface MirrorFile {
  path: string;
  sha: string;
  size: number;
}

interface MirrorChange {
  added: MirrorFile[];
  modified: MirrorFile[];
  removed: string[];
  renamed: Array<{ from: string; to: string; sha: string; size: number }>;
}

const isFile = (value: unknown): value is MirrorFile => typeof value === "object" && value !== null && typeof (value as MirrorFile).path === "string" && typeof (value as MirrorFile).sha === "string";
const isChange = (value: unknown): value is MirrorChange => {
  const change = value as Partial<MirrorChange> | null;
  return (
    typeof change === "object" &&
    change !== null &&
    Array.isArray(change.added) && change.added.every(isFile) &&
    Array.isArray(change.modified) && change.modified.every(isFile) &&
    Array.isArray(change.removed) && change.removed.every((path) => typeof path === "string") &&
    Array.isArray(change.renamed) && change.renamed.every((move) => typeof move === "object" && move !== null && typeof move.from === "string" && typeof move.to === "string" && typeof move.sha === "string")
  );
};

export type MirrorState =
  | {
      kind: "files";
      version: number;
      files: Map<string, string>;
      headSha: string | null;
      added: Set<string>;
    }
  | { kind: "building" }
  | { kind: "not_installed" }
  | { kind: "unknown"; status: number | null };

export class MirrorClient {
  private version: number | null = null;
  private files = new Map<string, string>();
  private headSha: string | null = null;
  private added = new Map<string, number>();

  constructor(
    private readonly api: SpecgitApi,
    private readonly repo: string,
    private readonly folder: string,
    private readonly state?: LocalState,
    private readonly now: () => number = Date.now,
  ) {
    this.key = `specgit-mirror-added-${hashText(`${repo}\n${folder}`)}`;
    try {
      const stored = state?.load(this.key);
      if (Array.isArray(stored)) {
        this.kept = new Map(stored.flatMap((one: unknown): Array<[string, number]> => (Array.isArray(one) && typeof one[0] === "string" && typeof one[1] === "number" ? [[one[0], one[1]]] : [])));
      }
    } catch {
      void 0;
    }
  }

  private readonly key: string;
  private kept = new Map<string, number>();

  repoPath(vaultPath: string): string {
    return this.folder !== "" && vaultPath.startsWith(`${this.folder}/`) ? vaultPath.slice(this.folder.length + 1) : vaultPath;
  }

  vaultPath(path: string): string {
    return this.folder === "" ? path : `${this.folder}/${path}`;
  }

  async moved(): Promise<boolean> {
    const before = this.version;
    const state = await this.read();
    return state.kind === "files" && state.version !== before;
  }

  async read(): Promise<MirrorState> {
    const named = splitRepo(this.repo);
    if (!named) return { kind: "unknown", status: null };
    const query: Record<string, string> = { branch: NOTE_BRANCH, folder: "", fresh: "1" };
    if (this.version !== null) query.since = String(this.version);
    let answer;
    try {
      answer = await this.api.call("GET", `/api/repos/${GIT_PROVIDER}/${named.owner}/${named.repo}/changes`, { query });
    } catch {
      return { kind: "unknown", status: null };
    }
    if (answer.status === 202) return { kind: "building" };
    if (answer.code === "app_not_installed") return { kind: "not_installed" };
    const body = answer.body;
    if (answer.status !== 200 || !body || typeof body.version !== "number") return { kind: "unknown", status: answer.status };
    if (Array.isArray(body.files)) {
      if (!body.files.every(isFile)) return { kind: "unknown", status: answer.status };
      const before = this.files;
      this.files = new Map((body.files).map((file) => [this.vaultPath(file.path), file.sha]));
      const was = new Map([...this.kept, ...this.added]);
      const next = new Map([...was].filter(([path]) => this.files.has(path)));
      for (const path of this.files.keys()) if (!next.has(path) && before.size > 0 && !before.has(path)) next.set(path, this.now());
      if (next.size !== was.size || [...next.keys()].some((path) => !was.has(path))) this.changed = true;
      this.added = next;
      this.kept = new Map();
    } else if (Array.isArray(body.changes)) {
      if (!body.changes.every(isChange)) return { kind: "unknown", status: answer.status };
      for (const change of body.changes) this.apply(change);
    }
    this.version = body.version;
    this.remember();
    this.headSha = typeof body.headSha === "string" ? body.headSha : null;
    return { kind: "files", version: body.version, files: new Map(this.files), headSha: this.headSha, added: new Set(this.added.keys()) };
  }

  private changed = false;

  settle(inVault: ReadonlySet<string>): void {
    for (const path of [...this.added.keys()]) {
      if (inVault.has(path.toLowerCase())) {
        this.added.delete(path);
        this.changed = true;
      }
    }
    this.remember();
  }

  private remember(): void {
    if (!this.changed) return;
    this.changed = false;
    const oldestFirst = [...this.added].sort((a, b) => a[1] - b[1]);
    for (const [path] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - ADDED_KEPT))) this.added.delete(path);
    try {
      this.state?.save(this.key, [...this.added].sort((a, b) => a[1] - b[1]));
    } catch {
      void 0;
    }
  }

  private apply(change: MirrorChange): void {
    for (const path of change.removed) {
      this.files.delete(this.vaultPath(path));
      this.changed = this.added.delete(this.vaultPath(path)) || this.changed;
    }
    for (const file of change.added) {
      this.files.set(this.vaultPath(file.path), file.sha);
      if (!this.added.has(this.vaultPath(file.path))) {
        this.changed = true;
        this.added.set(this.vaultPath(file.path), this.now());
      }
    }
    for (const file of change.modified) this.files.set(this.vaultPath(file.path), file.sha);
    for (const move of change.renamed) {
      this.files.delete(this.vaultPath(move.from));
      this.changed = this.added.delete(this.vaultPath(move.from)) || this.changed;
      this.files.set(this.vaultPath(move.to), move.sha);
      if (!this.added.has(this.vaultPath(move.to))) {
        this.changed = true;
        this.added.set(this.vaultPath(move.to), this.now());
      }
    }
  }
}
