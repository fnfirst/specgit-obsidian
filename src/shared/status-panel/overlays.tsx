import { useEffect, useRef } from "react";
import type { ConfirmQuestion, PanelMenuItem } from "./types";

export interface OpenMenu {
  items: readonly PanelMenuItem[];
  anchor: HTMLElement;
  right: number;
  top?: number;
  bottom?: number;
}

const ITEM_HEIGHT = 36;

export function placeMenu(root: HTMLElement | null, anchor: HTMLElement, count: number): Pick<OpenMenu, "right" | "top" | "bottom"> {
  const box = root ? root.getBoundingClientRect() : { left: 0, top: 0, right: 0, width: 0, height: 4000 };
  const rect = anchor.getBoundingClientRect();
  const right = Math.max(4, box.width - (rect.right - box.left));
  const below = rect.bottom - box.top + 2;
  const view = anchor.ownerDocument.defaultView?.innerHeight ?? box.top + box.height;
  if (rect.bottom + 2 + count * ITEM_HEIGHT + 8 > view && rect.top > count * ITEM_HEIGHT) return { right, bottom: box.height - (rect.top - box.top) + 2 };
  return { right, top: below };
}

export function MenuPopover({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (event: Event) => {
      if (!list.current?.contains(event.target as Node | null)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  const move = (by: number) => {
    const all = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const at = all.indexOf(list.current?.ownerDocument.activeElement as HTMLElement);
    all[(at + by + all.length) % all.length]?.focus();
  };
  return (
    <div
      ref={list}
      role="menu"
      className="sp-menu"
      style={{ right: menu.right, ...(menu.bottom === undefined ? { top: menu.top } : { bottom: menu.bottom }) }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home") {
          event.preventDefault();
          move(event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : -1000);
        } else if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          onClose();
          menu.anchor.focus();
        }
      }}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? "sp-menu-item sp-danger" : "sp-menu-item"}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function ConfirmDialog({ question, onChoose }: { question: ConfirmQuestion; onChoose: (id: string) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  return (
    <div className="sp-scrim" onKeyDown={(event) => event.key === "Escape" && onChoose("")}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={question.title} className="sp-dialog">
        <p className="sp-dialog-title">{question.title}</p>
        <div className="sp-dialog-buttons">
          {question.choices.map((choice) => (
            <button key={choice.id} type="button" className={choice.primary ? "sp-btn sp-primary" : "sp-btn"} onClick={() => onChoose(choice.id)}>
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
