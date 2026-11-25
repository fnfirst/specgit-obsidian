import { roomShas } from "./room-writes";
import type { StayState } from "./state";

export const OWN_AUTOSAVES_PER_NOTE = 128;
export const OWN_PINNED_PER_NOTE = 16;

const PIN_PREFIX = "!";

const revOfText = (text: string): string => roomShas(text).join("|");

const isPinned = (item: string): boolean => item.startsWith(PIN_PREFIX);

const stripPin = (item: string): string => (isPinned(item) ? item.slice(PIN_PREFIX.length) : item);

const revMatches = (rev: string, sha: string): boolean => rev === sha || rev.split("|").includes(sha);

const revOverlaps = (a: string, b: string): boolean => a === b || a.split("|").some((sha) => revMatches(b, sha));

export class OwnBlobs {
  private readonly rebasedSent = new Map<string, string>();

  constructor(
    private readonly state: StayState,
    private readonly onChange: () => void,
  ) {}

  stop(): void {
    this.rebasedSent.clear();
  }

  noteRebasedSent(path: string, sha: string): void {
    this.rebasedSent.set(path, sha);
  }

  consumeRebasedSent(path: string, sha: string): boolean {
    if (this.rebasedSent.get(path) !== sha) return false;
    this.rebasedSent.delete(path);
    return true;
  }

  recordSha(path: string, sha: string, pin = true): void {
    if (sha === "") return;
    this.append(path, sha, pin);
  }

  recordText(path: string, text: string, currentBase?: string | null): void {
    const rev = revOfText(text);
    if (currentBase !== undefined && currentBase !== null && revMatches(rev, currentBase)) return;
    this.append(path, rev, false);
  }

  pinText(path: string, text: string): void {
    const map = this.state.data.ownBlobs;
    const list = map?.[path];
    if (!map || !list) return;
    const rev = revOfText(text);
    let existing = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (revOverlaps(stripPin(list[i]!), rev)) {
        existing = i;
        break;
      }
    }
    if (existing === -1) return;
    const prior = stripPin(list[existing]!);
    const merged = prior.includes("|") ? prior : rev;
    const nextItem = `${PIN_PREFIX}${merged}`;
    if (list[existing] === nextItem) return;
    const next = [...list];
    next[existing] = nextItem;
    map[path] = this.cap(next);
    this.onChange();
  }

  matches(path: string, sha: string): boolean {
    return this.state.data.ownBlobs?.[path]?.some((item) => revMatches(stripPin(item), sha)) === true;
  }

  clear(path: string): void {
    this.settled(path, null);
  }

  settled(path: string, sha: string | null): void {
    if (sha === null || this.rebasedSent.get(path) !== sha) this.rebasedSent.delete(path);
    const map = this.state.data.ownBlobs;
    const list = map?.[path];
    if (!map || !list) return;
    if (sha === null) {
      delete map[path];
    } else {
      let last = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (revMatches(stripPin(list[i]!), sha)) {
          last = i;
          break;
        }
      }
      const rest = last === -1 ? [] : list.slice(last + 1);
      if (rest.length === 0) delete map[path];
      else map[path] = rest;
    }
    if (Object.keys(map).length === 0) delete this.state.data.ownBlobs;
    this.onChange();
  }

  renamed(from: string, to: string): void {
    if (from === to) return;
    const moved = this.rebasedSent.get(from);
    if (moved !== undefined) {
      this.rebasedSent.delete(from);
      this.rebasedSent.set(to, moved);
    }
    const map = this.state.data.ownBlobs;
    if (!map || map[from] === undefined) return;
    map[to] = map[from];
    delete map[from];
    this.onChange();
  }

  private append(path: string, rev: string, pin: boolean): void {
    const map = (this.state.data.ownBlobs ??= {});
    const list = [...(map[path] ?? [])];
    if (pin) {
      let existing = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (revOverlaps(stripPin(list[i]!), rev)) {
          existing = i;
          break;
        }
      }
      if (existing !== -1) {
        const prior = stripPin(list[existing]!);
        const merged = prior.includes("|") ? prior : rev;
        const nextItem = `${PIN_PREFIX}${merged}`;
        if (list[existing] === nextItem) return;
        list[existing] = nextItem;
      } else {
        list.push(`${PIN_PREFIX}${rev}`);
      }
    } else {
      const last = list[list.length - 1];
      if (last !== undefined && revOverlaps(stripPin(last), rev)) return;
      list.push(rev);
    }
    map[path] = this.cap(list);
    this.onChange();
  }

  private cap(list: string[]): string[] {
    let pinned = 0;
    let autosaves = 0;
    for (const item of list) {
      if (isPinned(item)) pinned++;
      else autosaves++;
    }
    let dropPinned = Math.max(0, pinned - OWN_PINNED_PER_NOTE);
    let dropAutosaves = Math.max(0, autosaves - OWN_AUTOSAVES_PER_NOTE);
    if (dropPinned === 0 && dropAutosaves === 0) return list;
    const kept: string[] = [];
    for (const item of list) {
      if (isPinned(item)) {
        if (dropPinned > 0) dropPinned--;
        else kept.push(item);
      } else if (dropAutosaves > 0) {
        dropAutosaves--;
      } else {
        kept.push(item);
      }
    }
    return kept;
  }
}
