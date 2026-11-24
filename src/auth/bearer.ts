import { abortError } from "./transport";

export interface Bearer {
  accessToken(): Promise<string>;
  renew(): Promise<string>;
}

export async function withBearer<Answer extends { status: number }>(
  auth: Bearer,
  send: (token: string) => Promise<Answer>,
  signal?: AbortSignal,
): Promise<Answer> {
  if (signal?.aborted) throw abortError();
  const token = await auth.accessToken();
  if (signal?.aborted) throw abortError();
  const first = await send(token);
  if (first.status !== 401) return first;
  if (signal?.aborted) throw abortError();
  const renewed = await auth.renew();
  if (signal?.aborted) throw abortError();
  return send(renewed);
}
