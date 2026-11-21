export const CONFIRMED_CAP_MS = 10 * 60_000;

export class Ledger {
  private readonly unlisted = new Map<string, number>();
  private readonly heard = new Map<string, number>();
  private readonly taken = new Map<string, { at: number; order: number }>();

  brought(ids: Iterable<string>, now: number): void {
    for (const id of ids) this.unlisted.set(id, now);
  }

  heardFrom(ids: Iterable<string>, reads: number): void {
    for (const id of ids) this.heard.set(id, reads);
  }

  awaited(id: string, read: { startedAt: number; order: number }): boolean {
    const reads = this.heard.get(id);
    if (reads !== undefined && read.order <= reads) return true;
    return (this.unlisted.get(id) ?? Number.NEGATIVE_INFINITY) > read.startedAt - CONFIRMED_CAP_MS;
  }

  gone(id: string, since: number): boolean {
    const taken = this.taken.get(id);
    return taken !== undefined && taken.order > since;
  }

  settled(read: { order: number; now: number }, listed: ReadonlySet<string>, before: Iterable<string>, onScreen: ReadonlySet<string>): void {
    for (const id of this.unlisted.keys()) if (listed.has(id) || !onScreen.has(id)) this.unlisted.delete(id);
    for (const [id, reads] of this.heard) if (listed.has(id) || !onScreen.has(id) || read.order > reads) this.heard.delete(id);
    for (const id of before) if (!onScreen.has(id)) this.taken.set(id, { at: read.now, order: read.order });
    for (const [id, taken] of this.taken) if (listed.has(id) || taken.at <= read.now - CONFIRMED_CAP_MS) this.taken.delete(id);
  }
}
