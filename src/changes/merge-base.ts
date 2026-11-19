import { toLf } from "../disk/line-endings";

export async function matchedBase(sha: string | null, readBlob: (sha: string) => Promise<string | null>, kept: () => string | null): Promise<string | null> {
  const blob = sha !== null ? await readBlob(sha) : null;
  return blob !== null ? toLf(blob) : kept();
}
