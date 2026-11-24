export const GIT_COPY_PATIENCE_MS = 5_000;
export const SENT_BASE_PATIENCE_MS = 15_000;

export function within<T>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(otherwise), ms);
    void promise.then(resolve, () => resolve(otherwise)).finally(() => window.clearTimeout(timer));
  });
}

export function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  otherwise: T,
  outer?: AbortSignal,
): Promise<T> {
  if (outer?.aborted) return Promise.resolve(otherwise);
  return new Promise((resolve) => {
    const controller = new AbortController();
    let done = false;
    const cleanup = (): void => {
      window.clearTimeout(timer);
      outer?.removeEventListener("abort", cancel);
    };
    const finish = (value: T): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const cancel = (): void => {
      if (done) return;
      done = true;
      cleanup();
      controller.abort();
      resolve(otherwise);
    };
    const timer = window.setTimeout(cancel, ms);
    outer?.addEventListener("abort", cancel, { once: true });
    let pending: Promise<T>;
    try {
      pending = work(controller.signal);
    } catch {
      finish(otherwise);
      return;
    }
    void pending.then(finish, () => finish(otherwise));
  });
}
