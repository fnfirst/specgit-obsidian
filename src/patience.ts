export const GIT_COPY_PATIENCE_MS = 5_000;

export function within<T>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(otherwise), ms);
    void promise.then(resolve, () => resolve(otherwise)).finally(() => window.clearTimeout(timer));
  });
}
