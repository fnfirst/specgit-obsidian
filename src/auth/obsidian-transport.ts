import { requestUrl } from "obsidian";
import { abortError, readingAgain, REQUEST_DEADLINE_MS, type Transport, withinDeadline } from "./transport";

export const obsidianTransport: Transport = readingAgain(async (request) => {
  const { binary, signal, ...asked } = request;
  if (signal?.aborted) throw abortError();
  const response = await withinDeadline(requestUrl({ ...asked, throw: false }), REQUEST_DEADLINE_MS, signal);
  return binary ? { status: response.status, text: "", bytes: response.arrayBuffer, headers: response.headers } : { status: response.status, text: response.text, headers: response.headers };
});
