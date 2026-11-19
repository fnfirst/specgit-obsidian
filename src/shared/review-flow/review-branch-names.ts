export type SavesTo = "shared" | "own";

export const SHARED_NAMESPACE = "shared";

const PREFIX = "specgit/review/";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const userNamespace = (login: string): string => slugify(login);

export function branchNamespace(branch: string): string | null {
  if (!branch.startsWith(PREFIX)) return null;
  const rest = branch.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  return slash > 0 && slash < rest.length - 1 ? rest.slice(0, slash) : null;
}

export function isSaveBranchFor(branch: string, login: string | null, saves?: SavesTo): boolean {
  const namespace = branchNamespace(branch);
  if (namespace === null) return false;
  const own = login ? userNamespace(login) : "";
  if (saves === "shared") return namespace === SHARED_NAMESPACE;
  if (saves === "own") return own !== "" && namespace === own;
  return namespace === SHARED_NAMESPACE || (own !== "" && namespace === own);
}
