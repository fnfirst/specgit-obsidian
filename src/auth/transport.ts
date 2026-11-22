export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  contentType?: string;
  body?: string;
  binary?: true;
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

export function withinDeadline<T>(answer: Promise<T>, ms: number = REQUEST_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(Object.assign(new Error("specgit didn't answer in time."), { name: "TimeoutError" })), ms);
    answer.then(resolve, reject).finally(() => window.clearTimeout(timer));
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

export function readingAgain(transport: Transport, pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => window.setTimeout(done, ms))): Transport {
  return (request) =>
    request.method === "GET"
      ? retryGet(() => transport(request), (err) => (err as Error)?.name === "TimeoutError", pause)
      : transport(request);
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
