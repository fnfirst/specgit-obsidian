import type { Text } from "@codemirror/state";
import { drawCaret, type PeerCaret, sameFields } from "./carets";
import { watchCaretChips } from "../shared/review-flow";

export interface ReadingPeer extends PeerCaret {
  line: number;
}

export function onLines(doc: Text, peers: readonly PeerCaret[]): ReadingPeer[] {
  return peers.map((peer) => ({ ...peer, line: doc.lineAt(Math.min(peer.head, doc.length)).number - 1 }));
}

export interface SectionContext {
  sourcePath: string;
  getSectionInfo: (el: HTMLElement) => { lineStart: number; lineEnd: number } | null;
}

export interface PeerBoard {
  publish(path: string, peers: readonly ReadingPeer[] | null, version?: number): void;
}

interface Section {
  path: string;
  place: (el: HTMLElement) => { lineStart: number; lineEnd: number } | null;
  lines: { start: number; end: number } | null;
  read: number;
  bars: Map<number, { peer: PeerCaret; dom: HTMLElement }>;
}

const GAP = 6;
const STEP = 4;
const MOST = 5_000;

export class ReadingBars implements PeerBoard {
  private readonly peers = new Map<string, readonly ReadingPeer[]>();
  private readonly versions = new Map<string, number>();
  private readonly sections = new Map<string, Set<WeakRef<HTMLElement>>>();
  private readonly byElement = new WeakMap<HTMLElement, Section>();
  private readonly gone = new FinalizationRegistry<{ path: string; ref: WeakRef<HTMLElement> }>(({ path, ref }) => {
    const mine = this.sections.get(path);
    mine?.delete(ref);
    if (mine?.size === 0) this.sections.delete(path);
  });
  private readonly watching = new Map<HTMLElement, { stop(): void; redrawn(): void }>();

  constructor(private readonly most: number = MOST) {}

  tracked(): number {
    let count = 0;
    this.sections.forEach((each) => each.forEach((ref) => ref.deref() && (count += 1)));
    return count;
  }

  process = (el: HTMLElement, ctx: SectionContext): void => {
    const { sourcePath: path } = ctx;
    const place = ctx.getSectionInfo;
    const info = ctx.getSectionInfo(el);
    if (info === null) return;
    let section = this.byElement.get(el);
    if (!section) {
      section = { path, place, lines: null, read: -1, bars: new Map() };
      this.byElement.set(el, section);
      const ref = new WeakRef(el);
      this.gone.register(el, { path, ref });
      const mine = this.sections.get(path) ?? new Set<WeakRef<HTMLElement>>();
      this.sections.set(path, mine);
      mine.add(ref);
      if (mine.size > this.most) {
        for (const old of mine) if (!old.deref()) mine.delete(old);
        for (const old of mine) {
          if (mine.size <= this.most) break;
          mine.delete(old);
          const evicted = old.deref();
          const gone = evicted && this.byElement.get(evicted);
          if (evicted && gone) {
            this.clear(gone, evicted);
            this.byElement.delete(evicted);
          }
        }
      }
    }
    section.lines = { start: info.lineStart, end: info.lineEnd };
    section.read = this.versions.get(path) ?? -1;
    if (this.peers.has(path)) this.paint(section, el);
  };

  publish(path: string, peers: readonly ReadingPeer[] | null, version = 0): void {
    if (peers === null) {
      this.peers.delete(path);
      this.versions.delete(path);
    } else {
      this.peers.set(path, peers);
      this.versions.set(path, version);
    }
    const mine = this.sections.get(path);
    if (!mine) return;
    for (const ref of mine) {
      const el = ref.deref();
      const section = el && this.byElement.get(el);
      if (!el || !section) mine.delete(ref);
      else if (peers === null) this.clear(section, el);
      else this.paint(section, el);
    }
    if (mine.size === 0) this.sections.delete(path);
  }

  destroy(): void {
    for (const mine of this.sections.values()) {
      for (const ref of mine) {
        const el = ref.deref();
        const section = el && this.byElement.get(el);
        if (el && section) this.clear(section, el);
      }
    }
    this.sections.clear();
    this.watching.forEach((watch) => watch.stop());
    this.watching.clear();
  }

  private clear(section: Section, el: HTMLElement): void {
    section.bars.forEach(({ dom }) => dom.remove());
    section.bars.clear();
    el.toggleClass("specgit-reading-section", false);
  }

  private paint(section: Section, el: HTMLElement): void {
    const version = this.versions.get(section.path) ?? 0;
    if (section.read !== version) {
      let info: ReturnType<Section["place"]> = null;
      try {
        info = section.place(el);
      } catch {
        info = section.lines && { lineStart: section.lines.start, lineEnd: section.lines.end };
      }
      section.lines = info ? { start: info.lineStart, end: info.lineEnd } : null;
      section.read = version;
    }
    const { lines } = section;
    const here = lines ? (this.peers.get(section.path) ?? []).filter((peer) => peer.line >= lines.start && peer.line <= lines.end) : [];
    for (const [id, bar] of section.bars) {
      if (!here.some((peer) => peer.id === id && sameFields(peer, bar.peer))) {
        bar.dom.remove();
        section.bars.delete(id);
      }
    }
    here.forEach((peer, step) => {
      let bar = section.bars.get(peer.id);
      if (!bar) {
        const dom = createDiv({ cls: "specgit-rendered is-reading" });
        dom.setCssProps({ "--specgit-peer": peer.color });
        dom.appendChild(drawCaret(peer)).addClass("is-rendered");
        el.appendChild(dom);
        bar = { peer, dom };
        section.bars.set(peer.id, bar);
      }
      bar.dom.setCssProps({ "--specgit-step": String(step) });
      bar.dom.querySelector<HTMLElement>(".specgit-caret")?.setCssProps({ left: `-${GAP + step * STEP}px` });
    });
    el.toggleClass("specgit-reading-section", section.bars.size > 0);
    if (section.bars.size > 0) this.watch(el);
  }

  private watch(el: HTMLElement): void {
    const root = el.closest<HTMLElement>(".markdown-preview-view");
    if (!root) return;
    const known = this.watching.get(root) ?? watchCaretChips(root, { chip: ".specgit-caret-chip", caret: ".specgit-caret" });
    this.watching.set(root, known);
    known.redrawn();
  }
}
