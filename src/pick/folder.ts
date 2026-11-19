export interface FolderProposal {
  folder: string;
  matched: number;
  total: number;
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const depthOf = (folder: string): number => (folder === "" ? 0 : folder.split("/").length);

function foldersHolding(repoPath: string, sameName: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const vaultPath of sameName) {
    if (vaultPath === repoPath) folders.add("");
    else if (vaultPath.endsWith(`/${repoPath}`)) folders.add(vaultPath.slice(0, vaultPath.length - repoPath.length - 1));
  }
  return folders;
}

function better(a: FolderProposal, b: FolderProposal): boolean {
  if (a.matched !== b.matched) return a.matched > b.matched;
  if (depthOf(a.folder) !== depthOf(b.folder)) return depthOf(a.folder) < depthOf(b.folder);
  return a.folder < b.folder;
}

export function proposeFolder(repoPaths: readonly string[], vaultPaths: readonly string[]): FolderProposal | null {
  const byName = new Map<string, string[]>();
  for (const path of vaultPaths) {
    const name = nameOf(path);
    const same = byName.get(name);
    if (same) same.push(path);
    else byName.set(name, [path]);
  }
  const files = new Set(repoPaths);
  const counts = new Map<string, number>();
  for (const repoPath of files) {
    for (const folder of foldersHolding(repoPath, byName.get(nameOf(repoPath)) ?? [])) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  let best: FolderProposal | null = null;
  for (const [folder, matched] of counts) {
    const candidate = { folder, matched, total: files.size };
    if (best === null || better(candidate, best)) best = candidate;
  }
  return best;
}
