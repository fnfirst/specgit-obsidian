import * as Y from "yjs";

export interface TextRun {
  readonly node: Y.XmlText;

  readonly value: string;

  readonly embeds: readonly number[];
}

export interface AtomRun {
  readonly atom: Y.XmlElement;

  readonly parent: Y.XmlElement;

  readonly target: string;
  readonly value: "";
}

export type TreeRun = TextRun | AtomRun;

export const isAtom = (run: TreeRun): run is AtomRun => "atom" in run;

const WIKI_LINK_TAG = "wikiLink";

function readRun(node: Y.XmlText): TextRun {
  let value = "";
  const embeds: number[] = [];
  let index = 0;
  for (const op of node.toDelta() as Array<{ insert: unknown }>) {
    if (typeof op.insert === "string") {
      value += op.insert;
      index += op.insert.length;
    } else embeds.push(index++);
  }
  return { node, value, embeds };
}

export class TreeIndex {

  version = 0;
  private list: TreeRun[] = [];
  private byNode = new Map<Y.XmlText, TextRun>();
  private structure = true;
  private readonly changed = new Set<Y.XmlText>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fragment: Y.XmlFragment) {
    fragment.observeDeep(this.onChange);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.fragment.unobserveDeep(this.onChange);
    this.listeners.clear();
  }

  runs(): readonly TreeRun[] {
    if (this.structure) this.walk();
    else if (this.changed.size > 0) this.refreshChanged();
    this.changed.clear();
    this.structure = false;
    return this.list;
  }

  private readonly onChange = (events: Array<Y.YEvent<Y.XmlText | Y.XmlElement | Y.XmlFragment>>): void => {
    this.version++;
    for (const event of events) {
      if (event.target instanceof Y.XmlText) this.changed.add(event.target);
      else this.structure = true;
    }
    this.listeners.forEach((listener) => listener());
  };

  private walk(): void {
    const list: TreeRun[] = [];
    const byNode = new Map<Y.XmlText, TextRun>();
    const visit = (parent: Y.XmlFragment | Y.XmlElement): void => {
      for (const child of parent.toArray()) {
        if (child instanceof Y.XmlText) {
          const known = this.changed.has(child) ? undefined : this.byNode.get(child);
          const run = known ?? readRun(child);
          list.push(run);
          byNode.set(child, run);
        } else if (child instanceof Y.XmlElement) {

          if (child.nodeName === WIKI_LINK_TAG && parent instanceof Y.XmlElement) {
            list.push({ atom: child, parent, target: String(child.getAttribute("target") ?? "").trim(), value: "" });
          } else visit(child);
        }
      }
    };
    visit(this.fragment);
    this.list = list;
    this.byNode = byNode;
  }

  private refreshChanged(): void {
    for (const node of this.changed) {
      const old = this.byNode.get(node);
      if (!old) continue;
      const run = readRun(node);
      this.list[this.list.indexOf(old)] = run;
      this.byNode.set(node, run);
    }
  }
}
