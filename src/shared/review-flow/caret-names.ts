import { pictureFailed, pictureLoaded, rememberPicture } from "./people";

export const CARET_NAME_MS = 1_800;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PointerAt {
  x: number;
  y: number;
  touch: boolean;
}

export interface CaretEditor<Caret> {
  chips(): readonly { box: Box; caret: Caret }[];
  listen(on: { moved(at: PointerAt): void; pressed(at: PointerAt): void; left(): void }): () => void;
  nextFrame(run: () => void): () => void;
  hover(caret: Caret | null, was: Caret | null): void;
  show(caret: Caret): void;
}

export function watchChips<Caret>(editor: CaretEditor<Caret>): { stop(): void; redrawn(): void; scrolled(): void } {
  let hovered: Caret | null = null;
  let inside = false;
  let cancelFrame: (() => void) | null = null;
  let last = { x: 0, y: 0 };
  const under = (x: number, y: number): Caret | null => {
    let top: Caret | null = null;
    for (const { box, caret } of editor.chips()) if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) top = caret;
    return top;
  };
  const mark = (caret: Caret | null): void => {
    if (caret === null && hovered === null) return;
    const was = hovered;
    hovered = caret;
    editor.hover(caret, was);
  };
  const lookSoon = (): void => {
    cancelFrame ??= editor.nextFrame(() => {
      cancelFrame = null;
      mark(under(last.x, last.y));
    });
  };
  const movedUnder = (): void => {
    if (inside) lookSoon();
  };
  const settle = (): void => {
    inside = false;
    cancelFrame?.();
    cancelFrame = null;
    mark(null);
  };
  const stop = editor.listen({
    moved: ({ x, y, touch }) => {
      if (touch) return;
      inside = true;
      last = { x, y };
      lookSoon();
    },
    pressed: ({ x, y, touch }) => {
      if (!touch) return;
      const caret = under(x, y);
      if (caret !== null) editor.show(caret);
    },
    left: settle,
  });
  return {
    stop: () => {
      stop();
      settle();
    },
    redrawn: movedUnder,
    scrolled: movedUnder,
  };
}

export const CARET_HOVERED = "is-hovered";
export const CARET_NAMED = "is-active";

export interface CaretWindow {
  requestAnimationFrame(run: () => void): number;
  cancelAnimationFrame(frame: number): void;
  addEventListener(type: string, listener: (event: unknown) => void, options?: { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: { capture?: boolean }): void;
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(timer: number): void;
}

interface InWindow {
  ownerDocument: { defaultView: CaretWindow | null };
}

export interface CaretElement extends InWindow {
  classList: { add(name: string): void; remove(name: string): void };
}

interface ChipElement {
  getBoundingClientRect(): Box;
  closest(selector: string): CaretElement | null;
}

export interface CaretRoot extends InWindow {
  querySelectorAll(selector: string): ArrayLike<ChipElement>;
  addEventListener(type: string, listener: (event: unknown) => void, options?: { passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

interface PointerShape {
  clientX: number;
  clientY: number;
  pointerType: string;
}

const timers = new WeakMap<CaretElement, { window: CaretWindow; timer: number }>();

export function showCaretName(caret: CaretElement): void {
  const window = caret.ownerDocument.defaultView;
  if (window === null) return;
  forgetCaretName(caret);
  caret.classList.add(CARET_NAMED);
  timers.set(caret, { window, timer: window.setTimeout(() => caret.classList.remove(CARET_NAMED), CARET_NAME_MS) });
}

export function forgetCaretName(caret: CaretElement): void {
  const set = timers.get(caret);
  if (set === undefined) return;
  set.window.clearTimeout(set.timer);
  timers.delete(caret);
}

export function watchCaretChips(root: CaretRoot, marks: { chip: string; caret: string }): { stop(): void; redrawn(): void } {
  const at = (event: unknown): PointerAt => {
    const { clientX, clientY, pointerType } = event as PointerShape;
    return { x: clientX, y: clientY, touch: pointerType === "touch" };
  };
  let scrollIn: CaretWindow | null = null;
  const scrolled = (): void => names.scrolled();
  const follow = (): void => {
    const now = root.ownerDocument.defaultView;
    if (now === null || now === scrollIn) return;
    scrollIn?.removeEventListener("scroll", scrolled, { capture: true });
    now.addEventListener("scroll", scrolled, { capture: true, passive: true });
    scrollIn = now;
  };
  const names = watchChips<CaretElement>({
    chips: () => {
      const found: { box: Box; caret: CaretElement }[] = [];
      for (const chip of Array.from(root.querySelectorAll(marks.chip))) {
        const caret = chip.closest(marks.caret);
        if (caret !== null) found.push({ box: chip.getBoundingClientRect(), caret });
      }
      return found;
    },
    listen: (on) => {
      const moved = (event: unknown): void => {
        follow();
        on.moved(at(event));
      };
      const pressed = (event: unknown): void => {
        follow();
        on.pressed(at(event));
      };
      const left = (): void => on.left();
      root.addEventListener("pointermove", moved, { passive: true });
      root.addEventListener("pointerdown", pressed, { passive: true });
      root.addEventListener("pointerleave", left);
      follow();
      return () => {
        root.removeEventListener("pointermove", moved);
        root.removeEventListener("pointerdown", pressed);
        root.removeEventListener("pointerleave", left);
        scrollIn?.removeEventListener("scroll", scrolled, { capture: true });
        scrollIn = null;
      };
    },
    nextFrame: (run) => {
      const view = root.ownerDocument.defaultView;
      if (view === null) return () => undefined;
      const frame = view.requestAnimationFrame(run);
      return () => view.cancelAnimationFrame(frame);
    },
    hover: (caret, was) => {
      was?.classList.remove(CARET_HOVERED);
      caret?.classList.add(CARET_HOVERED);
    },
    show: showCaretName,
  });
  return { stop: () => names.stop(), redrawn: () => names.redrawn() };
}

export interface ChipImage {
  src: string;
  alt: string;
  draggable: boolean;
  referrerPolicy: string;
  addEventListener(type: string, listener: () => void): void;
}

export interface ChipBox {
  textContent: string | null;
  replaceChildren(...nodes: unknown[]): void;
}

export function fillChip(chip: ChipBox, initials: string, picture: string | null, image: () => ChipImage): void {
  chip.textContent = initials;
  if (picture === null || pictureFailed(picture)) return;
  const face = image();
  face.alt = "";
  face.draggable = false;
  face.referrerPolicy = "no-referrer";
  let shown = false;
  const show = (): void => {
    shown = true;
    chip.replaceChildren(face);
  };
  face.addEventListener("load", () => {
    rememberPicture(picture, "loaded");
    show();
  });
  face.addEventListener("error", () => {
    rememberPicture(picture, "failed");
    if (shown) chip.textContent = initials;
  });
  face.src = picture;
  if (pictureLoaded(picture)) show();
}
