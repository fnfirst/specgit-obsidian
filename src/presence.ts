import type { Awareness } from "y-protocols/awareness";
import { ACTOR_FIELD, BRIDGE_FIELD, LOGIN_FIELD, OBSIDIAN_ACTOR } from "./protocol";
import { drawableAvatar, type OwnPlaces, ownPlaces, type RoomPerson, roomPerson } from "./shared/review-flow";

export interface Identity {
  name: string;
  login: string;
  color: string;
  avatarUrl: string;
}

const HEX = /^#[0-9a-f]{6}$/i;
const PALETTE = ["#958DF1", "#F98181", "#FBBC88", "#FAF594", "#70CFF8", "#94FADB", "#B9F18D"];

export function colorFor(identity: Identity): string {
  if (HEX.test(identity.color)) return identity.color;
  let hash = 0;
  for (const unit of identity.login) hash = (hash * 31 + unit.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? "#958DF1";
}

export function publishIdentity(awareness: Awareness, identity: Identity): void {
  const color = colorFor(identity);
  const avatarUrl = drawableAvatar(identity.avatarUrl);
  awareness.setLocalState({
    ...(awareness.getLocalState() ?? {}),
    user: { name: identity.name, color, colorLight: `${color}33`, ...(avatarUrl === null ? {} : { avatarUrl }) },
    [ACTOR_FIELD]: OBSIDIAN_ACTOR,
    [LOGIN_FIELD]: identity.login,
  });
}

const fieldOf = (state: unknown, field: string): unknown => (typeof state === "object" && state !== null ? Reflect.get(state, field) : undefined);

export const isAgentState = (state: unknown): boolean => fieldOf(fieldOf(state, ACTOR_FIELD), "kind") === "agent";

export function othersIn(awareness: Awareness): number {
  return othersOf(awareness).size;
}

export function otherPeople(awareness: Awareness): Here[] {
  return [...othersOf(awareness).values()].filter((person) => person.gaveName).map((person) => ({ name: person.label, login: person.login, initials: person.initials, picture: person.picture }));
}

export interface Here {
  name: string;
  login: string | null;
  initials: string;
  picture: string | null;
}

export function ownPlacesIn(awareness: Awareness): OwnPlaces {
  const states: unknown[] = [];
  for (const [client, state] of awareness.getStates()) {
    if (client === awareness.clientID || fieldOf(state, BRIDGE_FIELD) !== undefined || isAgentState(state)) continue;
    states.push(state);
  }
  return ownPlaces(states, roomPerson(awareness.getLocalState()).login);
}

function othersOf(awareness: Awareness): Map<string, RoomPerson> {
  const mine = roomPerson(awareness.getLocalState()).login;
  const people = new Map<string, RoomPerson>();
  for (const [client, state] of awareness.getStates()) {
    if (client === awareness.clientID || fieldOf(state, BRIDGE_FIELD) !== undefined) continue;
    const kind = fieldOf(fieldOf(state, ACTOR_FIELD), "kind");
    if (kind !== undefined && kind !== "person") continue;
    const person = roomPerson(state);
    if (person.login !== null && person.login === mine) continue;
    people.set(person.login !== null ? `login:${person.login}` : `client:${client}`, person);
  }
  return people;
}
