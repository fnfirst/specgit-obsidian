import { joinList, sameLogin } from "./people";
import type { ReviewTone } from "./review-state";

export const NAMES_SHOWN = 3;

const same = sameLogin;

function listed(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN) return joinList(names);
  return `${names.slice(0, NAMES_SHOWN - 1).join(", ")} and ${names.length - (NAMES_SHOWN - 1)} more`;
}

function distinct(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  return logins.filter((login) => {
    const key = login.toLowerCase();
    if (!login || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function groupWriters(entries: readonly { writers?: readonly string[] }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    for (const login of entry.writers ?? []) {
      const key = login.toLowerCase();
      if (login === "" || seen.has(key)) continue;
      seen.add(key);
      out.push(login);
    }
  }
  return out;
}

export function writersLine(writers: readonly string[], viewer: string | null): string {
  const all = distinct(writers);
  const mine = all.some((login) => same(login, viewer));
  return listed([...(mine ? ["you"] : []), ...all.filter((login) => !same(login, viewer))]);
}

export function liveWho(people: readonly string[], agents: number, viewer: string | null): { names: string; many: boolean } | null {
  const others = distinct(people).filter((login) => !same(login, viewer));
  const agentWords = agents <= 0 ? [] : [agents === 1 ? "an agent" : `${agents} agents`];
  const names = [...others, ...agentWords];
  if (names.length === 0) return null;
  return { names: listed(names), many: others.length + Math.max(agents, 0) !== 1 };
}

export function liveLine(people: readonly string[], agents: number, viewer: string | null): string | null {
  const who = liveWho(people, agents, viewer);
  return who === null ? null : `${who.names} ${who.many ? "are" : "is"} in it now`;
}

export const LIVE_NOW_TITLE = "Live now";
export const IN_PROGRESS_TITLE = "In progress";

export const draftStateWord = (isDraft: boolean): "Draft" | "In review" => (isDraft ? "Draft" : "In review");

export type AwareTone = ReviewTone | "live";

export const AWARE_TONES = { live: "live", draft: "muted", review: "info" } as const satisfies Record<string, AwareTone>;

export const stateTone = (state: "Draft" | "In review"): AwareTone => (state === "Draft" ? AWARE_TONES.draft : AWARE_TONES.review);
