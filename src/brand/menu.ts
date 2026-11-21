import { Menu } from "obsidian";

export interface MenuLine {
  label: string;
  run?: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export const MENU_RULE = "rule" as const;

let open: { under: HTMLElement; menu: Menu } | null = null;
let lastClosed: { under: HTMLElement; at: number } | null = null;
let pressClosedIt = false;

export function openMenu(under: HTMLElement, lines: ReadonlyArray<MenuLine | typeof MENU_RULE>, closed: () => void): Menu {
  const menu = new Menu();
  for (const line of lines) {
    if (line === MENU_RULE) {
      menu.addSeparator();
      continue;
    }
    menu.addItem((item) => {
      item.setTitle(line.label);
      if (line.run === undefined) item.setIsLabel(true);
      else item.onClick(line.run);
      if (line.disabled === true) item.setDisabled(true);
      if (line.danger === true) item.setWarning(true);
    });
  }
  menu.onHide(() => {
    if (open?.menu === menu) open = null;
    lastClosed = { under, at: performance.now() };
    closed();
  });
  open = { under, menu };
  const box = under.getBoundingClientRect();
  menu.showAtPosition({ x: box.right, y: box.bottom + 4, left: true }, under.ownerDocument);
  return menu;
}

export function closeMenus(): void {
  open?.menu.hide();
}

export function menuButton(lines: () => ReadonlyArray<MenuLine | typeof MENU_RULE>, setOpen: (open: boolean) => void): { onMouseDown: (event: MouseEvent) => void; onClick: (event: MouseEvent) => void } {
  return {
    onMouseDown: (event) => {
      const under = event.currentTarget as Node | null;
      pressClosedIt = under === open?.under || (lastClosed !== null && lastClosed.under === under && performance.now() - lastClosed.at < 50);
    },
    onClick: (event) => {
      const under = event.currentTarget as Node | null;
      const closing = pressClosedIt;
      pressClosedIt = false;
      if (!under?.instanceOf(HTMLElement) || closing) return;
      if (open?.under === under) return void open.menu.hide();
      const menu = openMenu(under, lines(), () => setOpen(false));
      if (open?.menu === menu) setOpen(true);
    },
  };
}
