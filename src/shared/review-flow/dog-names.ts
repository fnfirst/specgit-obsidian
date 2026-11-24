export const PUBLIC_DOG_NAMES = [
  "Luna",
  "Bella",
  "Charlie",
  "Max",
  "Milo",
  "Cooper",
  "Daisy",
  "Lucy",
  "Buddy",
  "Rocky",
  "Sadie",
  "Bailey",
  "Teddy",
  "Bear",
  "Lola",
  "Zoe",
  "Duke",
  "Penny",
  "Oliver",
  "Stella",
  "Bentley",
  "Ruby",
  "Tucker",
  "Rosie",
  "Winston",
  "Biscuit",
  "Mochi",
  "Waffles",
  "Pepper",
  "Scout",
  "Maple",
  "Clover",
] as const;

export const ANON_LOGIN_PREFIX = "anon:";

function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function anonymousDogAlias(scopeKey: string, realIdentity: string, used?: Set<string>): { login: string; name: string } {
  const start = fnv1a(`${scopeKey}\0${realIdentity.toLowerCase()}`) % PUBLIC_DOG_NAMES.length;
  for (let round = 1; ; round += 1) {
    for (let offset = 0; offset < PUBLIC_DOG_NAMES.length; offset += 1) {
      const base = PUBLIC_DOG_NAMES[(start + offset) % PUBLIC_DOG_NAMES.length]!;
      const dogName = round === 1 ? base : `${base} ${round}`;
      const login = `${ANON_LOGIN_PREFIX}${dogName.toLowerCase().replace(/\s+/g, "-")}`;
      if (!used || !used.has(login)) {
        used?.add(login);
        return { login, name: `Anonymous ${dogName}` };
      }
    }
  }
}

export function anonymousDisplayName(login: string): string {
  if (!login.startsWith(ANON_LOGIN_PREFIX)) return login;
  const parts = login
    .slice(ANON_LOGIN_PREFIX.length)
    .split("-")
    .filter((part) => part !== "");
  if (parts.length === 0) return "Anonymous";
  const words = parts.map((part) => (/^\d+$/.test(part) ? part : part.slice(0, 1).toUpperCase() + part.slice(1)));
  return `Anonymous ${words.join(" ")}`;
}

export function anonymizePublicPeople<T extends { login: string; name?: string | null; avatarUrl?: string | null }>(
  scopeKey: string,
  people: readonly T[],
): T[] {
  const used = new Set<string>();
  const ordered = people
    .map((person) => {
      const identity = person.login.toLowerCase();
      return { person, identity, hash: fnv1a(`${scopeKey}\0${identity}`) };
    })
    .sort((a, b) => (a.hash !== b.hash ? a.hash - b.hash : a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const mapped = ordered.map(({ person }) => {
    const alias = anonymousDogAlias(scopeKey, person.login, used);
    return {
      ...person,
      login: alias.login,
      name: alias.name,
      avatarUrl: null,
    };
  });
  return mapped.sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
}
