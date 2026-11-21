import { isHiddenPath, LISTED_FILE } from "../mapping";

export interface MissingNotes {
  copy: string[];
  skipped: string[];
}

export function missingNotes(repoPaths: Iterable<string>, vaultPaths: Iterable<string>, deleted: Iterable<string> = [], folder = ""): MissingNotes {
  const taken = new Set([...vaultPaths, ...deleted].map((path) => path.toLowerCase()));
  const found: MissingNotes = { copy: [], skipped: [] };
  const copied = new Set<string>();
  for (const path of repoPaths) {
    if (!LISTED_FILE.test(path) || isHiddenPath(path)) continue;
    const place = (folder === "" ? path : `${folder}/${path}`).toLowerCase();
    if (taken.has(place)) {
      if (copied.has(place)) found.skipped.push(path);
      continue;
    }
    taken.add(place);
    copied.add(place);
    found.copy.push(path);
  }
  return found;
}
