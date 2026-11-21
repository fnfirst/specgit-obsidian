import { requestUrl } from "obsidian";
import { readingAgain, type Transport, withinDeadline } from "./transport";

export const obsidianTransport: Transport = readingAgain(async (request) => {
  const { binary, ...asked } = request;
  const response = await withinDeadline(requestUrl({ ...asked, throw: false }));
  return binary ? { status: response.status, text: "", bytes: response.arrayBuffer, headers: response.headers } : { status: response.status, text: response.text };
});
