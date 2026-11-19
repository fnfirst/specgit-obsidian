import { useState } from "react";
import { STATUS_FOLDS, STATUS_ROW_MENU, statusFoldProgress, statusFoldRow, statusShowMore } from "../review-flow";
import { DRAW_LIMIT } from "./logic";
import { ChevronIcon } from "./icons";
import { buttonsOff, cx, MoreButton, type Ctx } from "./shared";
import type { StatusFold } from "./types";

const FOLD_WORDS: Record<StatusFold["id"], { label: string; button: string }> = { "not-here": STATUS_FOLDS.notHere, newer: STATUS_FOLDS.newer, deleted: STATUS_FOLDS.deleted, offered: STATUS_FOLDS.offered };

export const foldOpenId = (fold: StatusFold["id"]): string => `fold:${fold}`;

export function FoldRow({ fold, ctx }: { fold: StatusFold; ctx: Ctx }) {
  const words = FOLD_WORDS[fold.id];
  const [open, setOpen] = useState(ctx.openGroups.has(foldOpenId(fold.id)));

  const [all, setAll] = useState(false);
  const heading = statusFoldRow(words.label, fold.count);
  const items = fold.items && fold.items.length > 0 ? fold.items : null;
  const listId = `sp-fold-${fold.id}-items`;
  return (
    <div>
      <div className="sp-fold-line">
        {items ? (
          <button type="button" className={cx("sp-twisty", open && "sp-twisty-open")} aria-expanded={open} aria-controls={listId} aria-label={heading} onClick={() => setOpen(!open)}>
            <ChevronIcon />
          </button>
        ) : null}
        <span className="sp-name">{fold.progress ? statusFoldProgress(fold.progress.done, fold.progress.total) : heading}</span>
        {!ctx.readOnly ? (
          <button type="button" className="sp-btn" disabled={buttonsOff(ctx) || !!fold.progress} onClick={() => ctx.act({ type: "fold", id: fold.id })}>
            {words.button}
          </button>
        ) : null}
      </div>
      {items && open ? (
        <ul className="sp-members sp-members-flush" id={listId} aria-label={heading}>
          {(all ? items : items.slice(0, DRAW_LIMIT)).map((item) => {
            const act = (action: "open" | "see-github") => ctx.act({ type: "fold-item", fold: "newer", id: item.id, action });
            const menuId = `fold-item:${item.id}`;
            return (
              <li key={item.id} className="sp-member">
                <button type="button" className="sp-name-link" title={item.folder ? `${item.folder}/${item.name}` : item.name} onClick={() => act("open")}>
                  {item.name}
                </button>
                <MoreButton
                  id={menuId}
                  name={item.name}
                  ctx={ctx}
                  open={(anchor) =>
                    ctx.openItems(
                      [
                        { label: STATUS_ROW_MENU.open, run: () => act("open") },
                        { label: STATUS_ROW_MENU["see-github"], run: () => act("see-github") },
                      ],
                      anchor,
                      menuId,
                    )
                  }
                />
              </li>
            );
          })}
          {!all && items.length > DRAW_LIMIT ? (
            <li className="sp-more-row">
              <button type="button" className="sp-link sp-show-more" onClick={() => setAll(true)}>
                {statusShowMore(items.length - DRAW_LIMIT)}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
