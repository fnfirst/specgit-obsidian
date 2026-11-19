import type { SpecgitApi } from "../api";
import { MirrorClient } from "./mirror";

export const BUILDING_WAIT_MS = 3_000;

export async function listRepository(api: SpecgitApi, repo: string, wait: (ms: number) => Promise<void>): Promise<{ commit: string | null; files: ReadonlyMap<string, string> } | null> {
  const mirror = new MirrorClient(api, repo, "");
  let read = await mirror.read();
  if (read.kind === "building") {
    await wait(BUILDING_WAIT_MS);
    read = await mirror.read();
  }
  return read.kind === "files" ? { commit: read.headSha, files: read.files } : null;
}
