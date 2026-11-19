import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { positionCard } from "../shared/status-panel/place-card";

export function placeTip(tip: HTMLElement | null, anchor: HTMLElement | null): void {
  if (!tip || !anchor) return;
  positionCard(tip, anchor, anchor.closest(".specgit-panel"));
}

const PRESS_MS = 450;
const TOUCH_STAY_MS = 3200;

export function useTipOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    const hide = (): void => setOpen(false);

    const [doc, win] = [activeDocument, activeWindow];
    doc.addEventListener("keydown", close);
    win.addEventListener("scroll", hide, true);
    win.addEventListener("resize", hide);
    return () => {
      doc.removeEventListener("keydown", close);
      win.removeEventListener("scroll", hide, true);
      win.removeEventListener("resize", hide);
    };
  }, [open]);
  return [open, setOpen];
}

export function useTipTouch(setOpen: (open: boolean) => void): { handlers: Record<string, (event: PointerEvent) => void>; guardClick: (go: () => void) => (event: Event) => void } {
  const timer = useRef(0);
  const pressed = useRef(false);
  const swallow = useRef(false);
  const later = (ms: number, run: () => void): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hide = (): void => {
    window.clearTimeout(timer.current);
    pressed.current = false;
    setOpen(false);
  };
  return {
    handlers: {
      onPointerDown: (event) => {
        if (event.pointerType !== "touch") return;
        swallow.current = false;
        pressed.current = true;
        later(PRESS_MS, () => {
          swallow.current = true;
          setOpen(true);
        });
      },
      onPointerUp: (event) => {
        if (event.pointerType !== "touch" || !pressed.current) return;
        pressed.current = false;
        if (swallow.current) later(TOUCH_STAY_MS, hide);
        else window.clearTimeout(timer.current);
      },
      onPointerCancel: hide,

      onContextMenu: (event) => {
        if (pressed.current || swallow.current) event.preventDefault();
      },
    },
    guardClick: (go) => (event) => {
      if (swallow.current) {
        swallow.current = false;
        event.preventDefault();
        return;
      }
      go();
    },
  };
}

export function Tip({ id, anchor, testId, children }: { id: string; anchor: HTMLElement; testId?: string; children: ComponentChildren }) {
  return createPortal(
    <div class="specgit-tip" role="tooltip" id={id} data-testid={testId} ref={(tip) => placeTip(tip, anchor)}>
      {children}
    </div>,
    anchor.ownerDocument.body,
  );
}
