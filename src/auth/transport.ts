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

export const headerOf = (response: HttpResponse, name: string): string | undefined => {
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

const READ_AGAIN_MS = [300, 1_000];

export function readingAgain(transport: Transport, pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => window.setTimeout(done, ms))): Transport {
  return async (request) => {
    for (const wait of READ_AGAIN_MS) {
      try {
        return await transport(request);
      } catch (err) {
        if (request.method !== "GET" || (err as Error)?.name === "TimeoutError") throw err;
        await pause(wait);
      }
    }
    return transport(request);
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
