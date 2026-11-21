declare const URL: new (address: string) => { href: string; protocol: string; hostname: string; port: string; username: string; password: string };

const AVATAR_HOSTS: ReadonlySet<string> = new Set(["avatars.githubusercontent.com", "private-avatars.githubusercontent.com"]);
const AVATAR_CHARS = 2000;

export function drawableAvatar(url: unknown): string | null {
  if (typeof url !== "string" || url.length > AVATAR_CHARS || !/^https:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && AVATAR_HOSTS.has(parsed.hostname) && parsed.port === "" && parsed.username === "" && parsed.password === "" && parsed.href.length <= AVATAR_CHARS ? parsed.href : null;
  } catch {
    return null;
  }
}

export const SOMEONE = "Someone";

declare const Intl: { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(text: string): Iterable<{ segment: string }> } };

export const UNITS_PER_CHARACTER = 32;
const MARKS_ON_A_LETTER = 8;

const MARK = /^\p{M}$/u;
const SPACE = /^\p{Z}$/u;
const CONTROL_OR_FORMAT = /^[\p{Cc}\p{Cf}]$/u;
const MONGOLIAN = /^\p{Script=Mongolian}$/u;
const NOT_ASSIGNED = /^\p{Cn}$/u;
const DRAWS_NOTHING_BY_DEFAULT = /^\p{Default_Ignorable_Code_Point}$/u;
const NONCHARACTER = /^\p{Noncharacter_Code_Point}$/u;

type Kind = "text" | "space" | "blank" | "mark" | "joiner" | "selector" | "tag" | "drop";

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const MONGOLIAN_VOWEL_SEPARATOR = 0x180e;

const isTagLetter = (point: number): boolean => point >= 0xe0061 && point <= 0xe007a;
const FLAG_REGIONS: ReadonlySet<string> = new Set(["gbeng", "gbsct", "gbwls"]);
const isBreak = (point: number): boolean => (point >= 0x09 && point <= 0x0d) || point === 0x85 || point === 0x2028 || point === 0x2029;

function kindOf(char: string): Kind {
  const point = char.codePointAt(0)!;
  if (point >= 0xd800 && point <= 0xdfff) return "drop";
  if (point === ZWNJ || point === ZWJ) return "joiner";
  if ((point >= 0xfe00 && point <= 0xfe0f) || (point >= 0xe0100 && point <= 0xe01ef)) return "selector";
  if (point >= 0xe0000 && point <= 0xe007f) return "tag";
  if (isBreak(point)) return "space";
  if (CONTROL_OR_FORMAT.test(char)) return "drop";
  if ((NOT_ASSIGNED.test(char) && DRAWS_NOTHING_BY_DEFAULT.test(char)) || NONCHARACTER.test(char)) return "drop";
  if (MARK.test(char)) return "mark";
  if (SPACE.test(char)) return "space";
  if (point === 0x115f || point === 0x1160 || point === 0x3164 || point === 0xffa0 || point === 0x2800 || point === 0x1d159) return "blank";
  return "text";
}

function flagEnd(chars: readonly string[], at: number): number {
  if (chars[at]!.codePointAt(0) !== BLACK_FLAG) return -1;
  let next = at + 1;
  while (next < chars.length && next - at <= 6 && isTagLetter(chars[next]!.codePointAt(0)!)) next++;
  if (next >= chars.length || chars[next]!.codePointAt(0) !== CANCEL_TAG) return -1;
  const region = chars.slice(at + 1, next).map((char) => String.fromCodePoint(char.codePointAt(0)! - 0xe0000)).join("");
  return FLAG_REGIONS.has(region) ? next : -1;
}

const mongolianLetter = (char: string): boolean => MONGOLIAN.test(char) && kindOf(char) === "text";

const keptSeparator = (chars: readonly string[], at: number): boolean =>
  chars[at]!.codePointAt(0) === MONGOLIAN_VOWEL_SEPARATOR && at > 0 && at + 1 < chars.length && mongolianLetter(chars[at - 1]!) && mongolianLetter(chars[at + 1]!);

function kept(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let marks = 0;
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at]!;
    const end = flagEnd(chars, at);
    if (end !== -1) {
      for (let i = at; i <= end; i++) out.push(chars[i]!);
      at = end;
      marks = 0;
      continue;
    }
    if (keptSeparator(chars, at)) {
      out.push(char);
      continue;
    }
    const kind = kindOf(char);
    if (kind === "drop" || kind === "tag") continue;
    if (kind === "mark") {
      if (marks >= MARKS_ON_A_LETTER) continue;
      marks++;
    } else if (kind !== "joiner" && kind !== "selector") marks = 0;
    out.push(isBreak(char.codePointAt(0)!) ? " " : char);
  }
  return out;
}

function trimmed(chars: readonly string[]): string {
  let from = 0;
  let to = chars.length;
  const kinds = chars.map(kindOf);
  while (from < to && (kinds[from] === "space" || kinds[from] === "joiner" || kinds[from] === "selector")) from++;
  const endsALetter = (at: number): boolean => chars[at]!.codePointAt(0) === ZWJ && kinds[at - 1] === "mark";
  while (to > from && (kinds[to - 1] === "space" || kinds[to - 1] === "drop" || (kinds[to - 1] === "joiner" && !endsALetter(to - 1)))) to--;
  let draws = false;
  for (let at = from; at < to && !draws; at++) draws = kinds[at] === "text";
  return draws ? chars.slice(from, to).join("") : "";
}

function held(cluster: string): string {
  if (cluster.length <= UNITS_PER_CHARACTER) return cluster;
  const cut = cluster.slice(0, UNITS_PER_CHARACTER);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = trimmed(kept(value.slice(0, max * UNITS_PER_CHARACTER)));
  if (text === "") return "";
  const clusters = Intl.Segmenter === undefined ? Array.from(text) : Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
  if (clusters.length <= max && clusters.every((cluster) => cluster.length <= UNITS_PER_CHARACTER)) return text;
  const long = clusters.slice(0, max).findIndex((cluster) => cluster.length > UNITS_PER_CHARACTER);
  const shown = long === -1 ? clusters.slice(0, max) : [...clusters.slice(0, long), held(clusters[long]!)];
  return trimmed(kept(shown.join("")));
}

export const safeName = (value: unknown): string => safeText(value, 40) || SOMEONE;

const FALLBACK_COLOR = "#30bced";
const COLOR_CHARS = 64;
const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i;

export const safeColor = (value: unknown): string => (typeof value === "string" && value.length <= COLOR_CHARS && COLOR.test(value) ? value : FALLBACK_COLOR);

export function initialsOf(name: string): string {
  const words = name.split(/\s+/).map((word) => [...word.matchAll(/[\p{L}\p{N}]/gu)].map((match) => match[0])).filter((letters) => letters.length > 0);
  const initials = words.length === 1 ? words[0]!.slice(0, 2) : words.slice(0, 2).map((letters) => letters[0]!);
  return initials.join("").toUpperCase();
}

export const faceInitials = (name: string): string => (name === SOMEONE ? "?" : initialsOf(name) || "?");

const IN_OBSIDIAN = " in Obsidian";
export const nameInObsidian = (name: string): string => (name.endsWith(IN_OBSIDIAN) ? name : `${name}${IN_OBSIDIAN}`);

export const USER_FIELD = "user";
export const ACTOR_FIELD = "actor";
export const LOGIN_FIELD = "login";
export const OBSIDIAN_ACTOR = { kind: "person", surface: "obsidian" } as const;

export function actorInObsidian(actor: unknown): boolean {
  return read(actor, "kind") === OBSIDIAN_ACTOR.kind && read(actor, "surface") === OBSIDIAN_ACTOR.surface;
}

export interface RoomPerson {
  name: string;
  label: string;
  named: boolean;
  gaveName: boolean;
  initials: string;
  color: string;
  picture: string | null;
  login: string | null;
  inObsidian: boolean;
  surface: string | null;
}

const read = (from: unknown, field: string): unknown => (typeof from === "object" && from !== null ? (from as Record<string, unknown>)[field] : undefined);

export function roomPerson(state: unknown): RoomPerson {
  const user = read(state, USER_FIELD);
  const actor = read(state, ACTOR_FIELD);
  const given = safeText(read(user, "name"), 40);
  const name = given || SOMEONE;
  const named = name !== SOMEONE;
  const login = safeText(read(state, LOGIN_FIELD), 40).toLowerCase();
  return {
    name,
    label: actorInObsidian(actor) ? nameInObsidian(name) : name,
    named,
    gaveName: given !== "",
    initials: faceInitials(name),
    color: safeColor(read(user, "color")),
    picture: drawableAvatar(read(user, "avatarUrl")),
    login: login === "" ? null : login,
    inObsidian: actorInObsidian(actor),
    surface: ((raw) => (typeof raw === "string" && raw !== "" && raw.length <= 20 ? raw : null))(read(actor, "surface")),
  };
}

export const PLACE_SURFACES = ["obsidian", "specgit", "claude", "chatgpt", "cursor", "copilot", "vscode", "other"] as const;
export type PlaceSurface = (typeof PLACE_SURFACES)[number];

export type OwnPlaces = Partial<Record<PlaceSurface, number>>;

export function placeOfSurface(surface: string | null | undefined): PlaceSurface {
  if (surface === null || surface === undefined) return "specgit";
  return PLACE_SURFACES.find((known) => known === surface) ?? "other";
}

export function ownPlaces(others: Iterable<unknown>, login: string | null | undefined): OwnPlaces {
  const places: OwnPlaces = {};
  if (!login) return places;
  for (const state of others) {
    const person = roomPerson(state);
    if (person.login !== login.toLowerCase()) continue;
    const place = placeOfSurface(person.surface);
    places[place] = (places[place] ?? 0) + 1;
  }
  return places;
}

const HOSTS: Partial<Record<PlaceSurface, string>> = { claude: "Claude", chatgpt: "ChatGPT", cursor: "Cursor", copilot: "Copilot", vscode: "VS Code" };

function placeParts(place: PlaceSurface, from: PlaceSurface): { prep: string; name: string } {
  if (place === "specgit") return from === "specgit" ? { prep: "in", name: "another tab" } : { prep: "on", name: "specgit.com" };
  if (place === "obsidian") return { prep: "in", name: "Obsidian" };
  if (place === "other") return { prep: "", name: "somewhere else" };
  return { prep: "in", name: HOSTS[place]! };
}

export function joinList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}

export function alsoIn(places: OwnPlaces, from: PlaceSurface): string {
  let before = "";
  const order = from === "obsidian" ? (["specgit", "obsidian", "claude", "chatgpt", "cursor", "copilot", "vscode", "other"] as const) : PLACE_SURFACES;
  const parts = order.filter((place) => (places[place] ?? 0) > 0).map((place) => {
    const { prep, name } = placeParts(place, from);
    const words = prep === "" || prep === before ? name : `${prep} ${name}`;
    before = prep;
    return words;
  });
  return parts.length === 0 ? "" : ` (also ${joinList(parts)})`;
}

export const webAlsoIn = (places: OwnPlaces): string => alsoIn(places, "specgit");

export const obsidianAlsoIn = (places: OwnPlaces): string => alsoIn(places, "obsidian");

const MAX_PICTURES = 200;
export const PICTURE_RETRY_MS = 60_000;
const pictures = new Map<string, { how: "loaded" | "failed"; at: number }>();

export function rememberPicture(address: string, how: "loaded" | "failed"): void {
  pictures.delete(address);
  pictures.set(address, { how, at: Date.now() });
  if (pictures.size > MAX_PICTURES) pictures.delete(pictures.keys().next().value!);
}

export function pictureFailed(address: string): boolean {
  const seen = pictures.get(address);
  return seen?.how === "failed" && Date.now() - seen.at < PICTURE_RETRY_MS;
}

export const pictureLoaded = (address: string): boolean => pictures.get(address)?.how === "loaded";

export const sameLogin = (a: string | null | undefined, b: string | null | undefined): boolean => a != null && b != null && a !== "" && b !== "" && a.toLowerCase() === b.toLowerCase();
