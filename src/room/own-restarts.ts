import type { LocalState } from "../disk/bases";
import type { AskedStep, RoomSteps, StepSent } from "../token-source";

interface Step {

  base: string;

  id: string;

  sent: StepSent;

  at: number;
}

const STORE_KEY = "specgit-own-steps";

const KEPT_MS = 7 * 24 * 60 * 60 * 1000;

export const STEP_LIMITS = { note: 250_000, chars: 500_000 };

const STEP_ID = /^[A-Za-z0-9_-]{16,64}$/;

type Word = "silent" | "before" | "after" | "none";

export class OwnRestarts {
  private readonly steps = new Map<string, Step[]>();

  constructor(
    private readonly newId: () => string = randomId,
    private readonly store: LocalState | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  expect(key: string, base: string): string {
    const id = this.newId();
    this.steps.set(key, [...(this.steps.get(key) ?? []), { base, id, sent: "out", at: this.now() }]);
    this.save();
    return id;
  }

  sent(key: string, id: string, how: Exclude<StepSent, "out">): void {
    const step = (this.steps.get(key) ?? []).find((one) => one.id === id);
    if (!step) return;
    step.sent = how;
    this.save();
  }

  pending(key: string): boolean {
    return (this.steps.get(key)?.length ?? 0) > 0;
  }

  asking(key: string): AskedStep[] {
    return (this.steps.get(key) ?? []).map((step) => ({ id: step.id, sent: step.sent }));
  }

  own(key: string, leaving: RoomSteps | null, next: RoomSteps | null): string | null {
    const theirs = (this.steps.get(key) ?? []).filter((step) => {

      if (wordOf(step.id, leaving)[0] === "after") return false;
      const [word, asked] = wordOf(step.id, next);

      return !(word === "none" && asked === "unsure");
    });
    return theirs.at(-1)?.base ?? null;
  }

  settle(key: string, steps: RoomSteps | null, afterRestart: boolean): void {
    const over = (this.steps.get(key) ?? []).filter((step) => {
      const [word, asked] = wordOf(step.id, steps);
      if (word === "after") return true;
      return word === "none" && (asked === "unsure" || (afterRestart && asked === "ok"));
    });
    if (over.length > 0) this.done(key, over.map((step) => step.id));
  }

  done(key: string, ids: readonly string[]): void {
    const left = (this.steps.get(key) ?? []).filter((step) => !ids.includes(step.id));
    if (left.length === 0) this.steps.delete(key);
    else this.steps.set(key, left);
    this.save();
  }

  private load(): void {
    let stored: unknown;
    try {
      stored = this.store?.load(STORE_KEY);
    } catch {
      return;
    }
    if (typeof stored !== "object" || stored === null) return;
    const oldest = this.now() - KEPT_MS;
    for (const [key, list] of Object.entries(stored as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const steps = list
        .filter(isStored)
        .filter((step) => step.at >= oldest)
        .map((step): Step => ({ base: step.base, id: step.id, sent: step.sent === "out" ? "unsure" : step.sent, at: step.at }));
      if (steps.length > 0) this.steps.set(key, steps);
    }
  }

  private save(): void {
    if (!this.store) return;
    const all = [...this.steps].flatMap(([key, steps]) => steps.map((step) => ({ key, step })));
    all.sort((a, b) => b.step.at - a.step.at);
    const kept = new Map<string, Step[]>();
    let chars = 0;
    for (const { key, step } of all) {
      if (step.base.length > STEP_LIMITS.note || chars + step.base.length > STEP_LIMITS.chars) continue;
      chars += step.base.length;
      kept.set(key, [step, ...(kept.get(key) ?? [])]);
    }
    try {
      this.store.save(STORE_KEY, kept.size === 0 ? null : Object.fromEntries(kept));
    } catch { /* empty */ }
  }
}

function wordOf(id: string, steps: RoomSteps | null): [Word, StepSent | null] {
  const asked = steps?.asked.find((one) => one.id === id);
  if (!asked || !steps || steps.said === null) return ["silent", null];
  if (steps.said.after.includes(id)) return ["after", asked.sent];
  return [steps.said.before.includes(id) ? "before" : "none", asked.sent];
}

const isStored = (value: unknown): value is Step => {
  if (typeof value !== "object" || value === null) return false;
  const { base, id, sent, at } = value as Record<string, unknown>;
  return typeof base === "string" && typeof id === "string" && STEP_ID.test(id) && typeof at === "number" && (sent === "out" || sent === "ok" || sent === "unsure");
};

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
