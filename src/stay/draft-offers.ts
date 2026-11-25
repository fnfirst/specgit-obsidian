import type { Looked } from "../changes/model";
import type { NoticeHandle } from "../notices";
import { sameLogin } from "../shared/review-flow";
import { type Draft, draftKey, draftWriter, type StayDrafts } from "./draft-state";
import type { StayState } from "./state";
import type { StayPorts } from "./types";
import { DRAFT_SAID } from "./words";

const offerKey = (draft: Pick<Draft, "branch" | "blob">): string => `${draft.branch}\0${draft.blob ?? ""}`;

export interface TeammateOfferContext {
  ports: Pick<StayPorts, "policy" | "login" | "aware" | "openStatus" | "notify" | "lookAgain">;
  state: StayState;
  settleNow(path: string): Promise<void>;
}

export class TeammateOffers {
  private readonly toldOffer = new Map<string, string>();
  private initial: Map<string, string> | null = null;
  private readonly initialOffered = new Set<string>();
  private offerNotice: NoticeHandle | null = null;
  private offerSaid = 0;

  constructor(private readonly ctx: TeammateOfferContext) {}

  stop(): void {
    this.offerNotice?.hide();
    this.offerNotice = null;
  }

  offer(path: string, draft: Draft | null): void {
    if (!draft || draft.blob === null) return;
    const key = offerKey(draft);
    if (this.toldOffer.get(path) === key) return;
    this.toldOffer.set(path, key);
    this.initialOffered.add(path);
  }

  policyFor(path: string, draft: Pick<Draft, "blob">): StayDrafts {
    const policy = this.ctx.ports.policy();
    return policy === "everyone" && draft.blob !== null && this.initial?.get(path) === draft.blob ? "mine" : policy;
  }

  noteInitial(looked: Looked, drafts: NonNullable<Looked["drafts"]>): void {
    if (this.initial !== null) return;
    const { ports } = this.ctx;
    this.initial = new Map();
    if (ports.policy() !== "everyone") return;
    for (const [path, draft] of drafts.byPath) {
      if (draft.blob === null || draft.inGroup === true) continue;
      const sentTo = looked.files.get(path)?.sentTo;
      const key = draftKey(draft);
      const followedAtStart = sameLogin(draftWriter(draft), ports.login()) || (key !== null && sentTo === key);
      if (!followedAtStart) this.initial.set(path, draft.blob);
    }
  }

  private remove(path: string, keepTold = false): boolean {
    if (!keepTold) this.toldOffer.delete(path);
    if (!this.initialOffered.delete(path)) return false;
    this.initial?.delete(path);
    return true;
  }

  private syncNotice(allowOpen: boolean): void {
    const count = this.initialOffered.size;
    this.lowerTold(count);
    if (count === 0) {
      this.offerNotice?.hide();
      this.offerNotice = null;
      this.offerSaid = 0;
      return;
    }
    const aware = this.ctx.ports.aware();
    const words = aware ? DRAFT_SAID.offerTogether(count) : DRAFT_SAID.offerTogetherPlain(count);
    if (this.offerNotice?.shown()) {
      this.offerNotice(words);
      this.offerSaid = count;
      return;
    }
    if (!allowOpen) {
      this.offerSaid = count;
      return;
    }
    if (this.offerNotice && count <= this.offerSaid) {
      this.offerSaid = count;
      return;
    }
    this.offerSaid = count;
    if (count <= (this.ctx.state.data.offerTold ?? 0)) return;
    this.ctx.state.data.offerTold = count;
    const action = aware ? { label: DRAFT_SAID.offerTogetherButton, run: () => this.ctx.ports.openStatus?.() } : { label: DRAFT_SAID.offerTogetherPlainButton, run: () => this.addAll() };
    this.offerNotice = this.ctx.ports.notify(words, action, { lasting: true }) ?? null;
  }

  tell(drafts: NonNullable<Looked["drafts"]>): void {
    const everyone = this.ctx.ports.policy() === "everyone";
    for (const path of [...this.initialOffered]) {
      const draft = drafts.byPath.get(path);
      const gone = drafts.level && draft?.blob == null;
      const advanced = everyone && this.initial?.has(path) === true && draft?.blob != null && draft.blob !== this.initial.get(path);
      if (gone || advanced) this.remove(path);
    }
    this.syncNotice(true);
  }

  private lowerTold(count: number): void {
    const { data } = this.ctx.state;
    if (data.offerTold !== undefined && count < data.offerTold) data.offerTold = count;
  }

  offered(): readonly string[] {
    return [...this.initialOffered];
  }

  drop(path: string, options?: { keepTold?: boolean }): void {
    if (!this.remove(path, options?.keepTold === true)) return;
    this.syncNotice(false);
  }

  addAll(): void {
    if (this.ctx.ports.policy() !== "everyone") {
      for (const path of [...this.initialOffered]) void this.ctx.settleNow(path);
      return;
    }
    for (const path of [...this.initialOffered]) this.remove(path, true);
    this.syncNotice(false);
    this.ctx.ports.lookAgain();
  }

  livened(isLive: (path: string) => boolean): void {
    for (const path of [...this.initialOffered]) if (isLive(path)) this.drop(path, { keepTold: true });
  }
}
