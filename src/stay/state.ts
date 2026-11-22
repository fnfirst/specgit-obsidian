import type { LocalState } from "../disk/bases";
import { hashText } from "../hash";

export interface StayData {
  v: 1;
  baseline: string[] | null;
  seen: Record<string, string> | null;
  guessed: string[];
  committed: string[];
  held: string[];
  kept: string[];
  burst: string[];
  heldShas?: Record<string, string>;
  editsHeld?: Record<string, string>;
  endedOwn?: Record<string, { sent: string; ended: "published" | "discarded" }>;
  typed?: Record<string, { sha: string; at: number }>;
  heldWhy?: Record<string, "closed" | "stopped" | "ended" | "closedElsewhere" | "flurry" | "github" | "tries" | "deleted">;
  flurryUntil?: Record<string, number>;
  deletedAt?: Record<string, number>;
  offerTold?: number;
  caseHeld?: Record<string, string>;
  attachments?: Record<string, { problems: Array<{ name: string; why: string; server?: true }>; tries: number }>;
}

export const ATTACHMENTS_KEPT = 100;
export const ATTACHMENTS_PER_NOTE = 50;
const WORDS_MAX = 300;

export const TYPED_KEPT = 200;

const empty = (): StayData => ({ v: 1, baseline: null, seen: null, guessed: [], committed: [], held: [], kept: [], burst: [] });

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function read(stored: unknown): StayData {
  if (typeof stored !== "object" || stored === null) return empty();
  const record = stored as Record<string, unknown>;
  if (record.v !== 1) return empty();
  const seen = typeof record.seen === "object" && record.seen !== null && !Array.isArray(record.seen) && Object.values(record.seen).every((sha) => typeof sha === "string") ? (record.seen as Record<string, string>) : null;
  const shas = record.heldShas;
  const heldShas = typeof shas === "object" && shas !== null && !Array.isArray(shas) && Object.values(shas).every((sha) => typeof sha === "string") ? { heldShas: shas as Record<string, string> } : {};
  const held = record.editsHeld;
  const editsHeld = typeof held === "object" && held !== null && !Array.isArray(held) && Object.values(held).every((sha) => typeof sha === "string") ? { editsHeld: held as Record<string, string> } : {};
  const ended = record.endedOwn;
  const endedOwn =
    typeof ended === "object" && ended !== null && !Array.isArray(ended) && Object.values(ended).every((one) => typeof one === "object" && one !== null && typeof (one as { sent?: unknown }).sent === "string" && ((one as { ended?: unknown }).ended === "published" || (one as { ended?: unknown }).ended === "discarded"))
      ? { endedOwn: ended as Record<string, { sent: string; ended: "published" | "discarded" }> }
      : {};
  const typedAt = record.typed;
  const typed =
    typeof typedAt === "object" && typedAt !== null && !Array.isArray(typedAt) && Object.values(typedAt).every((one) => typeof one === "object" && one !== null && typeof (one as { sha?: unknown }).sha === "string" && typeof (one as { at?: unknown }).at === "number")
      ? { typed: typedAt as Record<string, { sha: string; at: number }> }
      : {};
  const why = record.heldWhy;
  const reasons = ["closed", "stopped", "ended", "closedElsewhere", "flurry", "github", "tries", "deleted"];
  const heldWhy = typeof why === "object" && why !== null && !Array.isArray(why) && Object.values(why).every((one) => typeof one === "string" && reasons.includes(one)) ? { heldWhy: why as NonNullable<StayData["heldWhy"]> } : {};
  const flurry = record.flurryUntil;
  const flurryUntil = typeof flurry === "object" && flurry !== null && !Array.isArray(flurry) && Object.values(flurry).every((at) => typeof at === "number" && Number.isFinite(at)) ? { flurryUntil: flurry as Record<string, number> } : {};
  const gone = record.deletedAt;
  const deletedAt = typeof gone === "object" && gone !== null && !Array.isArray(gone) && Object.values(gone).every((at) => typeof at === "number" && Number.isFinite(at)) ? { deletedAt: gone as Record<string, number> } : {};
  const toldCount = record.offerTold;
  const offerTold = typeof toldCount === "number" && Number.isInteger(toldCount) && toldCount >= 0 ? { offerTold: toldCount } : {};
  const caseMap = record.caseHeld;
  const caseHeld = typeof caseMap === "object" && caseMap !== null && !Array.isArray(caseMap) && Object.values(caseMap).every((sha) => typeof sha === "string") ? { caseHeld: caseMap as Record<string, string> } : {};
  const left = record.attachments;
  const isProblem = (one: unknown): boolean => typeof one === "object" && one !== null && typeof (one as { name?: unknown }).name === "string" && (one as { name: string }).name.length <= WORDS_MAX && typeof (one as { why?: unknown }).why === "string" && (one as { why: string }).why.length <= WORDS_MAX && ((one as { server?: unknown }).server === undefined || (one as { server?: unknown }).server === true);
  const isKept = (one: unknown): boolean => typeof one === "object" && one !== null && Array.isArray((one as { problems?: unknown }).problems) && (one as { problems: unknown[] }).problems.length > 0 && (one as { problems: unknown[] }).problems.length <= ATTACHMENTS_PER_NOTE && (one as { problems: unknown[] }).problems.every(isProblem) && Number.isInteger((one as { tries?: unknown }).tries) && (one as { tries: number }).tries >= 0 && (one as { tries: number }).tries <= 20;
  const attachments = typeof left === "object" && left !== null && !Array.isArray(left) && Object.keys(left).length <= ATTACHMENTS_KEPT && Object.values(left).every(isKept) ? { attachments: left as NonNullable<StayData["attachments"]> } : {};
  return { v: 1, baseline: isStrings(record.baseline) ? record.baseline : null, seen, guessed: isStrings(record.guessed) ? record.guessed : [], committed: isStrings(record.committed) ? record.committed : [], held: isStrings(record.held) ? record.held : [], kept: isStrings(record.kept) ? record.kept : [], burst: isStrings(record.burst) ? record.burst : [], ...heldShas, ...editsHeld, ...endedOwn, ...typed, ...heldWhy, ...flurryUntil, ...deletedAt, ...offerTold, ...caseHeld, ...attachments };
}

export class StayState {
  data: StayData;
  private readonly key: string;
  private dead = false;
  private written: string;

  constructor(
    place: string,
    private readonly state: LocalState,
  ) {
    this.key = `specgit-stay-${hashText(place)}`;
    try {
      this.data = read(this.state.load(this.key));
    } catch {
      this.data = empty();
    }
    this.written = JSON.stringify(this.data);
  }

  save(): void {
    if (this.dead) return;
    const json = JSON.stringify(this.data);
    if (json === this.written) return;
    try {
      this.state.save(this.key, this.data);
      this.written = json;
    } catch {
      void 0;
    }
  }

  clear(): void {
    this.dead = true;
    this.data = empty();
    try {
      this.state.save(this.key, null);
    } catch {
      void 0;
    }
  }
}
