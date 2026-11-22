export class OwnLinks {
  private readonly byNote = new Map<string, Set<string>>();

  added(notePath: string, links: readonly string[]): void {
    if (links.length === 0) return;
    let known = this.byNote.get(notePath);
    if (!known) {
      known = new Set<string>();
      this.byNote.set(notePath, known);
    }
    for (const link of links) known.add(link);
  }

  has(notePath: string, link: string): boolean {
    return this.byNote.get(notePath)?.has(link) === true;
  }

  moved(from: string, to: string): void {
    if (from === to) return;
    const known = this.byNote.get(from);
    if (!known) return;
    this.byNote.delete(from);
    let target = this.byNote.get(to);
    if (!target) {
      target = new Set<string>();
      this.byNote.set(to, target);
    }
    for (const link of known) target.add(link);
  }

  forget(notePath: string): void {
    this.byNote.delete(notePath);
  }
}
