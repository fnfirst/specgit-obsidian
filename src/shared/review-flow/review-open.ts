import { COMMENT_WORDS } from "./comment-copy";

export const REVIEW_VISIBLE_RETRY_MS = 1500;

export type ReviewStart<Pr> = { ok: true; pr?: Pr } | { ok: false; message: string | null };

export interface ReviewOpenerDeps {
  wait(ms: number): Promise<void>;
  later(run: () => void, ms: number): void;
}

export class ReviewOpener<Pr = unknown> {
  private readonly starts = new Map<string, Promise<ReviewStart<Pr>>>();

  constructor(private readonly deps: ReviewOpenerDeps) {}

  private startOnce(key: string, begin: () => Promise<ReviewStart<Pr>>): Promise<ReviewStart<Pr>> {
    const known = this.starts.get(key);
    if (known) return known;
    const start = begin();
    const forget = (): void => {
      if (this.starts.get(key) === start) this.starts.delete(key);
    };
    this.starts.set(key, start);
    start.then(
      (answer) => (answer.ok ? this.deps.later(forget, REVIEW_VISIBLE_RETRY_MS) : forget()),
      forget,
    );
    return start;
  }

  reset(): void {
    this.starts.clear();
  }

  async run<T>(
    key: string,
    write: () => Promise<T>,
    options: { isNotOpen: (error: unknown) => boolean; start: () => Promise<ReviewStart<Pr>>; onPr?: (pr: Pr) => void },
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (!options.isNotOpen(error)) throw error;
    }
    const revision = await this.startOnce(key, options.start);
    if (!revision.ok) throw new Error(revision.message ?? COMMENT_WORDS.needsReview);
    if (revision.pr !== undefined) options.onPr?.(revision.pr);
    try {
      return await write();
    } catch (error) {
      if (!options.isNotOpen(error)) throw error;
      await this.deps.wait(REVIEW_VISIBLE_RETRY_MS);
      return write();
    }
  }
}
