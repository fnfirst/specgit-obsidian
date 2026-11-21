export const CARD_EDGE = 8;
export const CARD_GAP = 6;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  width: number;
  height: number | null;
  side: "below" | "above";
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function placeCard(input: { control: Box; card: { width: number; height: number }; clip: Box; others?: readonly Box[]; edge?: number; gap?: number }): Placement {
  const edge = input.edge ?? CARD_EDGE;
  const gap = input.gap ?? CARD_GAP;
  const { control, clip } = input;
  const width = Math.max(0, Math.min(input.card.width, clip.right - clip.left - 2 * edge));
  const centre = (control.left + control.right) / 2;
  const left = Math.max(clip.left + edge, Math.min(centre - width / 2, clip.right - edge - width));
  const height = input.card.height;
  const roomBelow = clip.bottom - edge - (control.bottom + gap);
  const roomAbove = control.top - gap - (clip.top + edge);
  const box = (top: number): Box => ({ left, top, right: left + width, bottom: top + height });
  const below = box(control.bottom + gap);
  const above = box(control.top - gap - height);
  const clear = (candidate: Box): boolean => !(input.others ?? []).some((other) => overlaps(candidate, other));
  const fitsBelow = roomBelow >= height;
  const fitsAbove = roomAbove >= height;
  if (fitsBelow && clear(below)) return { left, top: below.top, width, height: null, side: "below" };
  if (fitsAbove && clear(above)) return { left, top: above.top, width, height: null, side: "above" };
  if (fitsBelow) return { left, top: below.top, width, height: null, side: "below" };
  if (fitsAbove) return { left, top: above.top, width, height: null, side: "above" };
  if (roomBelow >= roomAbove) return { left, top: below.top, width, height: Math.max(0, roomBelow), side: "below" };
  const cut = Math.max(0, roomAbove);
  return { left, top: control.top - gap - cut, width, height: cut, side: "above" };
}

const rectOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};
const intersect = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

const INTERACTIVE = "button, a[href], input, select, textarea, summary, [role='button'], [role='switch'], [role='tab'], [role='checkbox'], [tabindex]:not([tabindex='-1'])";

export function positionCard(card: HTMLElement, anchor: HTMLElement, pane: Element | null): Placement | null {
  const doc = anchor.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  let clip: Box = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
  if (pane) clip = { ...clip, left: Math.max(clip.left, rectOf(pane).left), right: Math.min(clip.right, rectOf(pane).right) };
  for (let el = anchor.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (style.overflowX !== "visible") clip = { ...clip, left: Math.max(clip.left, rectOf(el).left), right: Math.min(clip.right, rectOf(el).right) };
  }
  for (let el = card.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (style.overflowY !== "visible") clip = { ...clip, top: Math.max(clip.top, rectOf(el).top), bottom: Math.min(clip.bottom, rectOf(el).bottom) };
  }
  card.style.removeProperty("max-height");
  card.style.maxWidth = `${Math.max(0, clip.right - clip.left - 2 * CARD_EDGE)}px`;
  const size = { width: card.offsetWidth, height: card.offsetHeight };
  const control = rectOf(anchor);
  const others = [...(pane ?? doc.body).querySelectorAll<HTMLElement>(INTERACTIVE)].filter((el) => {
    if (el === anchor || el.contains(anchor) || anchor.contains(el) || card.contains(el)) return false;
    const box = rectOf(el);
    if (box.right <= box.left || box.bottom <= box.top) return false;
    const shared = intersect(box, control);
    return !(shared.right > shared.left && shared.bottom > shared.top && (shared.right - shared.left) * (shared.bottom - shared.top) > 0.5 * (box.right - box.left) * (box.bottom - box.top));
  }).map(rectOf);
  const placement = placeCard({ control, card: size, clip, others });
  let origin = { left: 0, top: 0 };
  if (view.getComputedStyle(card).position !== "fixed" && card.offsetParent) {
    const parent = card.offsetParent.getBoundingClientRect();
    origin = { left: parent.left + card.offsetParent.clientLeft - card.offsetParent.scrollLeft, top: parent.top + card.offsetParent.clientTop - card.offsetParent.scrollTop };
  }
  card.style.left = `${placement.left - origin.left}px`;
  card.style.top = `${placement.top - origin.top}px`;
  card.style.removeProperty("bottom");
  card.style.width = `${placement.width}px`;
  if (placement.height !== null) {
    card.style.maxHeight = `${placement.height}px`;
  }
  return placement;
}
