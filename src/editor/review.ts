import { toLf } from "../disk/line-endings";
import type { Room } from "../room/room";
import type { Outcome, Snapshot } from "./join";
import type { EditorServices, Settle } from "./services";

export interface ReviewHost {
  name(): string;
  room(): Room | null;
  text(): string;
  meet(text: string, room: Room): Outcome;
}

export type Verdict = { applied: string } | "closed" | "withdrawn";

const NOT_READY = "specgit is catching this note up. Try again in a moment.";

export class Review {
  private asked: AbortController | null = null;
  private snapshot: Snapshot = { mine: "", theirs: "" };

  constructor(
    private readonly services: EditorServices,
    private readonly host: ReviewHost,
  ) {}

  get open(): boolean {
    return this.asked !== null;
  }

  async ask(outcome: Extract<Outcome, { kind: "review" }>): Promise<Verdict> {
    const asked = new AbortController();
    this.asked = asked;
    this.snapshot = outcome.snapshot;
    try {
      const text = await this.services.review({
        kind: "text",
        name: this.host.name(),
        regions: outcome.regions,
        fromBase: outcome.fromBase,
        settle: () => this.settle(),
        signal: asked.signal,
      });
      return asked.signal.aborted ? "withdrawn" : text === null ? "closed" : { applied: text };
    } finally {
      if (this.asked === asked) this.asked = null;
    }
  }

  withdraw(): void {
    this.asked?.abort();
    this.asked = null;
  }

  private settle(): Settle {
    const room = this.host.room();
    if (!room?.bindable) return { error: NOT_READY };
    const [mine, theirs] = [this.host.text(), toLf(room.text.toJSON())];
    if (mine === this.snapshot.mine && theirs === this.snapshot.theirs) return null;
    const again = this.host.meet(mine, room);
    if (again.kind === "review") {
      this.snapshot = again.snapshot;
      return { regions: again.regions };
    }
    if (again.kind === "bind") {
      this.snapshot = { mine, theirs };
      return { regions: [{ kind: "same", text: again.text }] };
    }
    return { error: again.kind === "wait" ? NOT_READY : again.why };
  }
}
