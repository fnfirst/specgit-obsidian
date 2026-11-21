import type { Looked } from "../changes/model";
import type { DraftInbound } from "./draft-inbound";
import type { StayPorts } from "./types";

export class FirstLook {
  private first: { added: number } | null = null;

  begin(): void {
    this.first = { added: 0 };
  }

  added(count: number): void {
    if (this.first) this.first.added += count;
  }

  report(ports: Pick<StayPorts, "awareLine">): void {
    const first = this.first;
    if (!first) return;
    this.first = null;
    ports.awareLine?.({ added: first.added });
  }
}

export interface OfferHost {
  draftIn(current: () => boolean): DraftInbound;
  existing(): DraftInbound | null;
  on(): boolean;
  looked(): Looked | null;
  phaseOf(path: string): string;
}

export class DraftOffers {
  private asked = false;

  constructor(private readonly host: OfferHost) {}

  add(path: string, always = false): void {
    const looked = this.host.looked();
    if (!looked) return;
    if (always) this.asked = true;
    this.host.draftIn(() => this.host.on() || this.asked).addNow(looked, path);
  }

  offered(): readonly string[] {
    return this.host.existing()?.offered() ?? [];
  }

  addAll(): void {
    this.host.existing()?.addAllOffered();
  }

  livened(): void {
    this.host.existing()?.livened((path) => this.host.phaseOf(path) === "live");
  }
}
