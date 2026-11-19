export function tokenSub(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { sub?: unknown };
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

const GITHUB_ID = /^github(?:-app)?:([1-9][0-9]{0,14})$/;

export function sameAccount(a: string, b: string): boolean {
  const [first, second] = [GITHUB_ID.exec(a)?.[1], GITHUB_ID.exec(b)?.[1]];
  return first !== undefined && second !== undefined ? first === second : a === b;
}
