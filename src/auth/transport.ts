export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  contentType?: string;
  body?: string;
  binary?: true;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  text: string;
  bytes?: ArrayBuffer;
  headers?: Record<string, string>;
}

export const headerOf = (response: Pick<HttpResponse, "headers">, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  return Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === wanted)?.[1];
};

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export const REQUEST_DEADLINE_MS = 180_000;

export function abortError(): Error {
  return Object.assign(new Error("The request was cancelled."), { name: "AbortError" });
}

const isAbortedError = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

export function withinDeadline<T>(answer: Promise<T>, ms: number = REQUEST_DEADLINE_MS, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    void answer.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const cleanup = (): void => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(abortError());
    };
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(Object.assign(new Error("specgit didn't answer in time."), { name: "TimeoutError" }));
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    void answer.then(
      (value) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function pauseWithSignal(ms: number, pause: ((ms: number) => Promise<void>) | undefined, signal?: AbortSignal): Promise<void> {
  if (pause === undefined) return waitOrAbort(ms, signal);
  if (!signal) return pause(ms);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const onAbort = (): void => {
      if (done) return;
      done = true;
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pause(ms).then(
      () => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export const READ_AGAIN_MS = [300, 1_000];

export async function retryGet<T>(
  run: () => Promise<T>,
  isAborted: (err: unknown) => boolean,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => window.setTimeout(done, ms)),
): Promise<T> {
  for (const wait of READ_AGAIN_MS) {
    try {
      return await run();
    } catch (err) {
      if (isAborted(err)) throw err;
      await pause(wait);
    }
  }
  return run();
}

export function readingAgain(transport: Transport, pause?: (ms: number) => Promise<void>): Transport {
  return (request) => {
    if (request.signal?.aborted) return Promise.reject(abortError());
    return request.method === "GET"
      ? retryGet(
          () => (request.signal?.aborted ? Promise.reject(abortError()) : transport(request)),
          (err) => request.signal?.aborted === true || isAbortedError(err),
          (ms) => pauseWithSignal(ms, pause, request.signal),
        )
      : transport(request);
  };
}

export function decodeHeaderPath(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return decodeURI(value);
  } catch {
    return undefined;
  }
}

export function parseApiAnswer(status: number, text: string): { status: number; body: Record<string, unknown> | null; message: string | null; code: string | null } {
  const body = jsonObject(text);
  const error = body && typeof body.error === "object" && body.error !== null ? (body.error as Record<string, unknown>) : null;
  return {
    status,
    body,
    message: typeof error?.message === "string" ? error.message : null,
    code: typeof error?.code === "string" ? error.code : typeof body?.code === "string" ? body.code : null,
  };
}

export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
