import { type EditorState, StateEffect, type Text } from "@codemirror/state";
import { BlockType, type BlockInfo, EditorView, layer, type LayerMarker, type ViewUpdate } from "@codemirror/view";
import { drawCaret, type PeerCaret, redrawCarets, sameFields } from "./carets";
import { caretRange, selectionRanges } from "./rendered-dom";
import { type BlockModel, blockModelAt } from "./rendered-text";

export const redrawRendered = StateEffect.define<null>();

export interface CommentRange {
  from: number;
  to: number;
  active: boolean;
}

export interface RenderedSources {
  peers(view: EditorView): readonly PeerCaret[];
  comments(state: EditorState): readonly CommentRange[];
  commentsChanged(update: ViewUpdate): boolean;
}

export interface Cover {
  kind: "block" | "inline" | "text";
  from: number;
  to: number;
}

const EDGE = 12;
const GAP = 8;
const STEP = 4;
const FLIP = 200;

const isWidgetBlock = (block: BlockInfo): boolean => block.type === BlockType.WidgetRange;

export function coverAt(view: EditorView, pos: number): Cover | null {
  const block = view.lineBlockAt(pos);
  if (isWidgetBlock(block)) return { kind: "block", from: block.from, to: block.to };
  let found: Cover | null = null;
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    set.between(pos, pos, (from, to, value) => {
      if (value.point && from < pos && pos < to && (!found || to - from > found.to - found.from)) found = { kind: "inline", from, to };
    });
  }
  return found;
}

function blocksIn(view: EditorView, from: number, to: number): BlockInfo[] {
  return view.viewportLineBlocks.filter((block) => isWidgetBlock(block) && block.to > from && block.from < to);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function base(view: EditorView): { left: number; top: number } {
  const scroller = view.scrollDOM.getBoundingClientRect();
  return { left: scroller.left - view.scrollDOM.scrollLeft * view.scaleX, top: scroller.top - view.scrollDOM.scrollTop * view.scaleY };
}

function blockElement(view: EditorView, pos: number): HTMLElement | null {
  const { node, offset } = view.domAtPos(pos);
  let at: Node | null = node === view.contentDOM ? (node.childNodes[offset] ?? node.childNodes[offset - 1] ?? null) : node;
  while (at && at.parentNode !== view.contentDOM) at = at.parentNode;
  return at?.instanceOf(HTMLElement) ? at : null;
}

function blockBox(view: EditorView, cover: Cover): Box {
  const { left, top } = base(view);
  const [sx, sy] = [view.scaleX, view.scaleY];
  const rect = blockElement(view, cover.from)?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) return { left: (rect.left - left) / sx, top: (rect.top - top) / sy, width: rect.width / sx, height: rect.height / sy };
  const content = view.contentDOM.getBoundingClientRect();
  const info = view.lineBlockAt(cover.from);
  return { left: (content.left - left) / sx, top: (view.documentTop - top) / sy + info.top, width: content.width / sx, height: info.height };
}

function inlineBox(view: EditorView, cover: Cover): Box | null {
  const start = view.coordsAtPos(cover.from, 1) ?? view.coordsAtPos(cover.from, -1);
  const end = view.coordsAtPos(cover.to, -1);
  if (!start) return null;
  const { left, top } = base(view);
  const [sx, sy] = [view.scaleX, view.scaleY];
  const sameLine = end !== null && Math.abs(end.top - start.top) < 2;
  const right = sameLine ? end.left : view.contentDOM.getBoundingClientRect().right;
  return { left: (start.left - left) / sx, top: (start.top - top) / sy, width: Math.max(0, right - start.left) / sx, height: (start.bottom - start.top) / sy };
}

const px = (value: number): string => `${Math.round(value * 100) / 100}px`;

function place(dom: HTMLElement, box: Box): void {
  dom.style.left = px(box.left);
  dom.style.top = px(box.top);
  dom.style.width = px(box.width);
  dom.style.height = px(box.height);
}

const sameBox = (a: Box, b: Box): boolean => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

interface Drawn {
  peer: PeerCaret;
  kind: string;
  dom: HTMLElement;
}

export class CoverMarker implements LayerMarker {
  constructor(
    readonly peer: PeerCaret,
    readonly cover: Cover,
    readonly box: Box,
    readonly step: number,
    readonly width: number,
    private readonly drawn: Map<number, Drawn> = new Map<number, Drawn>(),
  ) {}

  eq(other: LayerMarker): boolean {
    return other instanceof CoverMarker && other.cover.kind === this.cover.kind && other.cover.from === this.cover.from && other.step === this.step && sameFields(other.peer, this.peer) && sameBox(other.box, this.box);
  }

  draw(): HTMLElement {
    const known = this.drawn.get(this.peer.id);
    if (known && known.kind === this.cover.kind && sameFields(known.peer, this.peer)) {
      this.keep(known.dom);
      return known.dom;
    }
    const wrapper = createDiv({ cls: `specgit-rendered is-${this.cover.kind}` });
    wrapper.setCssProps({ "--specgit-peer": this.peer.color });
    wrapper.appendChild(drawCaret(this.peer)).addClass("is-rendered");
    this.keep(wrapper);
    return wrapper;
  }

  update(dom: HTMLElement, old: LayerMarker): boolean {
    if (!(old instanceof CoverMarker) || old.peer.id !== this.peer.id || old.cover.kind !== this.cover.kind || !sameFields(old.peer, this.peer)) return false;
    this.keep(dom);
    return true;
  }

  private keep(dom: HTMLElement): void {
    this.drawn.set(this.peer.id, { peer: this.peer, kind: this.cover.kind, dom });
    this.place(dom);
  }

  private place(wrapper: HTMLElement): void {
    place(wrapper, this.box);
    wrapper.setCssProps({ "--specgit-step": String(this.step) });
    const caret = wrapper.querySelector<HTMLElement>(".specgit-caret");
    if (!caret) return;
    if (this.cover.kind === "block") {
      const out = this.box.left - GAP - this.step * STEP;
      const bar = out >= EDGE ? out : EDGE + this.step * STEP;
      caret.setCssProps({ left: px(bar - this.box.left) });
    } else {
      caret.style.removeProperty("left");
      caret.toggleClass("is-flipped", this.box.left > this.width - FLIP);
    }
  }
}

export class TintMarker implements LayerMarker {
  constructor(
    readonly kind: "selection" | "comment",
    readonly block: { from: number; to: number },
    readonly box: Box,
    readonly look: string,
  ) {}

  eq(other: LayerMarker): boolean {
    return other instanceof TintMarker && other.kind === this.kind && other.block.from === this.block.from && other.look === this.look && sameBox(other.box, this.box);
  }

  draw(): HTMLElement {
    const tint = createDiv({ cls: `specgit-rendered-tint is-${this.kind}` });
    this.paint(tint);
    return tint;
  }

  update(dom: HTMLElement, old: LayerMarker): boolean {
    if (!(old instanceof TintMarker) || old.kind !== this.kind) return false;
    this.paint(dom);
    return true;
  }

  private paint(tint: HTMLElement): void {
    place(tint, this.box);
    if (this.kind === "selection") tint.setCssProps({ "--specgit-peer": this.look });
    else tint.toggleClass("is-active", this.look === "active");
  }
}

const elements = new WeakMap<EditorView, Map<number, Drawn>>();
export function elementsOf(view: EditorView): Map<number, Drawn> {
  let known = elements.get(view);
  if (!known) elements.set(view, (known = new Map<number, Drawn>()));
  return known;
}

const texts = new WeakMap<Text, string>();
function markdownOf(view: EditorView): string {
  const doc = view.state.doc;
  let text = texts.get(doc);
  if (text === undefined) texts.set(doc, (text = doc.toString()));
  return text;
}

interface Widget {
  element: HTMLElement;
  model: BlockModel;
}

function widgetOf(view: EditorView, block: { from: number; to: number }): Widget | null {
  const model = blockModelAt(markdownOf(view), block.from);
  const element = blockElement(view, block.from);
  return model && element && model.from >= block.from && model.to <= block.to ? { element, model } : null;
}

function boxOf(view: EditorView, rect: DOMRect | { left: number; top: number; width: number; height: number }): Box {
  const { left, top } = base(view);
  return { left: (rect.left - left) / view.scaleX, top: (rect.top - top) / view.scaleY, width: rect.width / view.scaleX, height: rect.height / view.scaleY };
}

function caretBox(view: EditorView, range: Range): Box | null {
  const own = range.getClientRects()[0];
  const { startContainer: node, startOffset: offset } = range;
  if (own && own.height > 0) return boxOf(view, { left: own.left, top: own.top, width: 0, height: own.height });
  const length = node.nodeValue?.length ?? 0;
  const beside = range.cloneRange();
  if (offset > 0) beside.setStart(node, offset - 1);
  else if (offset < length) beside.setEnd(node, offset + 1);
  else return null;
  const rects = beside.getClientRects();
  const rect = offset > 0 ? rects[rects.length - 1] : rects[0];
  if (!rect || rect.height <= 0) return null;
  return boxOf(view, { left: offset > 0 ? rect.right : rect.left, top: rect.top, width: 0, height: rect.height });
}

function onBlock(view: EditorView, element: HTMLElement, box: Box): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return true;
  const area = boxOf(view, rect);
  return box.left >= area.left - 2 && box.left + box.width <= area.left + area.width + 2 && box.top >= area.top - 2 && box.top + box.height <= area.top + area.height + 2;
}

export class SpanMarker implements LayerMarker {
  constructor(
    readonly color: string,
    readonly box: Box,
  ) {}

  eq(other: LayerMarker): boolean {
    return other instanceof SpanMarker && other.color === this.color && sameBox(other.box, this.box);
  }

  draw(): HTMLElement {
    const span = createDiv({ cls: "specgit-rendered-span" });
    this.paint(span);
    return span;
  }

  update(dom: HTMLElement, old: LayerMarker): boolean {
    if (!(old instanceof SpanMarker)) return false;
    this.paint(dom);
    return true;
  }

  private paint(span: HTMLElement): void {
    place(span, this.box);
    span.setCssProps({ "--specgit-peer": this.color });
  }
}

export function renderedMarkers(view: EditorView, sources: RenderedSources): LayerMarker[] {
  const peers = sources.peers(view);
  const comments = sources.comments(view.state);
  const spans: LayerMarker[] = [];
  const tints: LayerMarker[] = [];
  const carets: LayerMarker[] = [];
  const seen = new Set<HTMLElement>();
  for (const peer of peers) {
    const [from, to] = [Math.min(peer.anchor, peer.head), Math.max(peer.anchor, peer.head)];
    if (from === to) continue;
    for (const block of blocksIn(view, from, to)) {
      const widget = widgetOf(view, block);
      if (widget) seen.add(widget.element);
      const ranges = widget && selectionRanges(widget.element, widget.model, from, to);
      const boxes = ranges?.flatMap((range) => Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => boxOf(view, rect)));
      if (widget && boxes && boxes.length > 0 && boxes.every((box) => onBlock(view, widget.element, box))) boxes.forEach((box) => spans.push(new SpanMarker(peer.color, box)));
      else tints.push(new TintMarker("selection", block, blockBox(view, { kind: "block", from: block.from, to: block.to }), peer.color));
    }
  }
  const commented = new Map<number, { block: BlockInfo; active: boolean }>();
  for (const range of comments) {
    for (const block of blocksIn(view, range.from, range.to)) {
      const known = commented.get(block.from);
      commented.set(block.from, { block, active: range.active || (known?.active ?? false) });
    }
  }
  for (const { block, active } of commented.values()) tints.push(new TintMarker("comment", block, blockBox(view, { kind: "block", from: block.from, to: block.to }), active ? "active" : ""));
  const stood = new Map<string, number>();
  const covered = new Set<number>();
  const width = view.scrollDOM.clientWidth;
  const drawn = elementsOf(view);
  for (const peer of peers) {
    let cover = coverAt(view, peer.head);
    if (!cover) continue;
    let box: Box | null = null;
    if (cover.kind === "block") {
      const widget = widgetOf(view, cover);
      if (widget) seen.add(widget.element);
      const range = widget && caretRange(widget.element, widget.model, peer.head);
      box = range ? caretBox(view, range) : null;
      if (box && !onBlock(view, widget!.element, box)) box = null;
      if (box) cover = { kind: "text", from: cover.from, to: cover.to };
      else box = blockBox(view, cover);
    } else {
      box = inlineBox(view, cover);
    }
    if (!box) continue;
    const key = cover.kind === "text" ? `text:${Math.round(box.left)}:${Math.round(box.top)}` : `${cover.kind}:${cover.from}`;
    const step = stood.get(key) ?? 0;
    stood.set(key, step + 1);
    carets.push(new CoverMarker(peer, cover, box, step, width, drawn));
    covered.add(peer.id);
  }
  drawn.forEach((_, id) => covered.has(id) || drawn.delete(id));
  watchers.get(view)?.follow(seen);
  return [...spans, ...tints, ...carets];
}

class Watch {
  private readonly observer: MutationObserver;
  private followed: HTMLElement[] = [];
  private frame: number | null = null;

  constructor(private readonly view: EditorView) {
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(view.contentDOM, { childList: true });
  }

  follow(blocks: ReadonlySet<HTMLElement>): void {
    if (blocks.size === this.followed.length && this.followed.every((block) => blocks.has(block))) return;
    this.followed = [...blocks];
    this.observer.disconnect();
    this.observer.observe(this.view.contentDOM, { childList: true });
    this.followed.forEach((block) => this.observer.observe(block, { subtree: true, childList: true, characterData: true }));
  }

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = this.view.dom.win.requestAnimationFrame(() => {
      this.frame = null;
      this.view.dispatch({ effects: redrawRendered.of(null) });
    });
  }

  stop(): void {
    this.observer.disconnect();
    if (this.frame !== null) this.view.dom.win.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.followed = [];
  }
}

const watchers = new WeakMap<EditorView, Watch>();

export function renderedLayer(sources: RenderedSources) {
  return layer({
    above: true,
    class: "specgit-rendered-layer",
    update: (update) => update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(redrawCarets) || effect.is(redrawRendered))) || sources.commentsChanged(update),
    markers: (view) => renderedMarkers(view, sources),
    mount: (_, view) => void watchers.set(view, new Watch(view)),
    destroy: (_, view) => {
      watchers.get(view)?.stop();
      watchers.delete(view);
    },
  });
}
