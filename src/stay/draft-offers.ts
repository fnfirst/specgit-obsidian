import type { Looked } from "../changes/model";
import type { NoticeHandle } from "../notices";
import { type Draft, follows, type StayDrafts } from "./draft-state";
import type { StayState } from "./state";
import type { StayPorts } from "./types";
import { DRAFT_SAID } from "./words";

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
    if (!draft || draft.blob === null || this.toldOffer.get(path) === draft.branch) return;
    this.toldOffer.set(path, draft.branch);
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
      if (!follows(draft, ports.login(), sentTo, "mine") && follows(draft, ports.login(), sentTo, "everyone")) this.initial.set(path, draft.blob);
    }
  }

  tell(drafts: NonNullable<Looked["drafts"]>): void {
    if (drafts.level) {
      for (const path of [...this.initialOffered]) {
        if (drafts.byPath.get(path)?.blob != null) continue;
        this.initialOffered.delete(path);
        this.initial?.delete(path);
        this.toldOffer.delete(path);
      }
    }
    this.show();
  }

  private show(): void {
    const count = this.initialOffered.size;
    this.lowerTold(count);
    if (count === 0) {
      this.offerNotice?.hide();
      this.offerNotice = null;
      return;
    }
    const aware = this.ctx.ports.aware();
    const words = aware ? DRAFT_SAID.offerTogether(count) : DRAFT_SAID.offerTogetherPlain(count);
    if (this.offerNotice?.shown()) {
      this.offerNotice(words);
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

  private lowerTold(count: number): void {
    const { data } = this.ctx.state;
    if (data.offerTold !== undefined && count < data.offerTold) data.offerTold = count;
  }

  offered(): readonly string[] {
    return [...this.initialOffered];
  }

  drop(path: string): void {
    if (!this.initialOffered.delete(path)) return;
    this.initial?.delete(path);
    const left = this.initialOffered.size;
    this.lowerTold(left);
    if (left === 0) {
      this.offerNotice?.hide();
      this.offerNotice = null;
    } else this.offerNotice?.(this.ctx.ports.aware() ? DRAFT_SAID.offerTogether(left) : DRAFT_SAID.offerTogetherPlain(left));
  }

  addAll(): void {
    if (this.ctx.ports.policy() !== "everyone") {
      for (const path of [...this.initialOffered]) void this.ctx.settleNow(path);
      return;
    }
    for (const path of this.initialOffered) this.initial?.delete(path);
    this.initialOffered.clear();
    this.lowerTold(0);
    this.offerNotice?.hide();
    this.offerNotice = null;
    this.ctx.ports.lookAgain();
  }

  livened(isLive: (path: string) => boolean): void {
    for (const path of this.initialOffered) if (isLive(path)) this.drop(path);
  }
}
