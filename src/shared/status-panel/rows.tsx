import { useState } from "react";
import {
  GROUP_CARD,
  STATUS_GROUP_MENU,
  STATUS_LABELS,
  STATUS_ROW_BUTTONS,
  STATUS_ROW_MENU,
  STATUS_TIPS,
  statusClipReason,
  statusGroupCount,
  statusShowMore,
  type StatusGroupMenuItem,
  type StatusRowMenuItem,
} from "../review-flow";
import { ChevronIcon } from "./icons";
import { buttonsOff, Check, cx, Edge, Faces, LiveWho, MoreButton, Pill, type Ctx } from "./shared";
import { DRAW_LIMIT, pillRepeatsChip, type Entry } from "./logic";
import type { Lane, StatusDoc, StatusGroup, StatusRowButton } from "./types";

const ROW_MENU_ORDER: readonly StatusRowMenuItem[] = ["open", "show-changes", "see-github", "see-difference", "submit-only", "publish-only", "add-reviewer", "move-back", "discard", "stop-review", "view-on-github", "bring-in"];
const VIEW_ONLY_MENU: readonly StatusRowMenuItem[] = ["open", "show-changes", "see-github", "see-difference", "view-on-github"];

function menuFor(doc: StatusDoc): readonly StatusRowMenuItem[] {

  const withReview: readonly StatusRowMenuItem[] = doc.hasReview ? ["stop-review", "view-on-github"] : [];
  if (doc.teammate) return ["open", ...(doc.menu?.includes("bring-in") ? (["bring-in"] as const) : []), ...(doc.hasReview ? (["view-on-github"] as const) : [])];
  if (doc.asksYou) return ["open", "show-changes", "view-on-github"];

  return [...COMPARISONS, ...ownMenu(doc, withReview), ...(doc.menu?.includes("bring-in") ? (["bring-in"] as const) : [])];
}

const COMPARISONS: readonly StatusRowMenuItem[] = ["see-github", "see-difference"];

function ownMenu(doc: StatusDoc, withReview: readonly StatusRowMenuItem[]): readonly StatusRowMenuItem[] {
  switch (doc.state) {
    case "in-review":
    case "changes-requested":
    case "out-of-date":
      return ["open", "show-changes", "add-reviewer", "move-back", "discard", "stop-review", "view-on-github"];
    case "ready":
      return ["open", "show-changes", "publish-only", "add-reviewer", "move-back", "discard", "stop-review", "view-on-github"];
    case "draft":
    case "edited":

      return ["open", "show-changes", ...(doc.check === "submit" ? (["submit-only"] as const) : []), "discard", ...withReview];
    case "changed-in-both":
      return ["open", "show-changes", "discard", ...withReview];
    case "held":
      return ["open", "show-changes", ...(doc.check === "submit" ? (["submit-only"] as const) : []), "discard", ...withReview];
    case "deleted":
      return [...(doc.check === "publish" ? (["publish-only"] as const) : []), "discard", ...(doc.hasReview ? (["view-on-github"] as const) : [])];
    default:
      return ["open"];
  }
}

export function rowMenuItems(doc: StatusDoc, ctx: Pick<Ctx, "noun" | "readOnly">): StatusRowMenuItem[] {
  const given = menuFor(doc);
  return ROW_MENU_ORDER.filter((item) => {
    if (!given.includes(item)) return false;
    if (item === "discard" && !(ctx.noun === "note" && doc.hasChanges)) return false;
    if (item === "see-github" && !doc.views?.includes("github")) return false;
    if (item === "see-difference" && !doc.views?.includes("difference")) return false;
    if (ctx.readOnly && !VIEW_ONLY_MENU.includes(item)) return false;
    return true;
  });
}

export const menuIsWorthDrawing = (items: readonly StatusRowMenuItem[]): boolean => items.some((item) => item !== "open");

export const rowMenuLabel = (item: StatusRowMenuItem): string => STATUS_ROW_MENU[item];

export function groupMenuItems(group: Pick<StatusGroup, "state" | "hasReview">, ctx: Pick<Ctx, "readOnly">): StatusGroupMenuItem[] {
  if (ctx.readOnly) return group.hasReview ? ["view-on-github"] : [];
  const withReview: StatusGroupMenuItem[] = group.hasReview ? ["stop-review", "view-on-github"] : [];
  const wanted: StatusGroupMenuItem[] = ["rename"];
  if (group.state !== "held") wanted.push("ungroup");
  switch (group.state) {
    case "draft":
      wanted.push("submit-only", ...withReview);
      break;
    case "ready":
      wanted.push("publish-only", "add-reviewer", "move-back", "stop-review", "view-on-github");
      break;
    case "in-review":
    case "changes-requested":
    case "out-of-date":
      wanted.push("add-reviewer", "move-back", "stop-review", "view-on-github");
      break;
    default:
      wanted.push(...withReview);
  }
  return (Object.keys(STATUS_GROUP_MENU) as StatusGroupMenuItem[]).filter((item) => wanted.includes(item));
}

export const memberMenuId = (member: string): string => `member:${member}`;
export const groupMenuLabel = (item: StatusGroupMenuItem): string => STATUS_GROUP_MENU[item];

export function RowButton({ button, id, ctx, group, ending }: { button: StatusRowButton; id: string; ctx: Ctx; group?: boolean; ending?: boolean }) {
  const label = STATUS_ROW_BUTTONS[button];
  const tip = button === "join" ? { picture: "join" as const, name: label, line: STATUS_TIPS.join } : null;
  const key = `${id}:button`;
  const stops = group === true && ending === true && button === "choose";
  return (
    <button type="button" className="sp-btn sp-row-button" disabled={stops ? ctx.offline : buttonsOff(ctx)} {...(tip ? ctx.tips.bind(key, tip) : {})} onClick={() => ctx.act(group && button === "choose" ? { type: "group", id, action: "choose" } : { type: "row", id, action: button })}>
      {label}
    </button>
  );
}

const flashClass = (id: string, ctx: Ctx): string | false => ctx.flash.has(id) && (ctx.flashHeld ? "sp-flash sp-flash-hold" : "sp-flash");

function Name({ doc, ctx }: { doc: StatusDoc; ctx: Ctx }) {

  const was = doc.renamedFrom ? ctx.tips.bind(`${doc.id}:name`, { picture: "changes", name: doc.name, line: STATUS_TIPS.wasNamed(doc.renamedFrom) }) : {};
  return (
    <button type="button" className="sp-name sp-name-link" title={doc.renamedFrom ? undefined : doc.folder ? `${doc.folder}/${doc.name}` : doc.name} {...was} onClick={() => ctx.act({ type: "row", id: doc.id, action: "open" })}>
      {doc.name}
    </button>
  );
}

const FIX_BUTTONS: readonly StatusRowButton[] = ["join", "catch-up", "choose"];

export function Row({ entry, ctx, lane }: { entry: Entry; ctx: Ctx; lane: Lane }) {
  const doc = entry.item as StatusDoc;
  const menu = rowMenuItems(doc, ctx);
  const more = menuIsWorthDrawing(menu) ? <MoreButton id={doc.id} name={doc.name} ctx={ctx} /> : null;
  const edge = <Edge when={doc.when} more={more} />;
  const fix = !ctx.readOnly && doc.button && FIX_BUTTONS.includes(doc.button) ? doc.button : null;
  const button = fix ? <RowButton button={fix} id={doc.id} ctx={ctx} /> : null;
  const check = <Check item={doc} ctx={ctx} />;
  const boxed = ctx.boxes || ctx.checkables.has(doc.id);
  const dropPill = !!doc.state && pillRepeatsChip(lane, doc.state, doc.asksYou);
  const pill = doc.state && !dropPill ? <Pill state={doc.state} tipPeople={doc.tipPeople} reason={doc.reason} asksYou={doc.asksYou} autoPublish={doc.autoPublish} id={doc.id} ctx={ctx} /> : null;
  const classes = cx("sp-row", entry.open && "sp-row-open", entry.needs && "sp-row-needs", flashClass(doc.id, ctx));
  if (fix && fix !== "join") {
    const conflict = doc.state === "changed-in-both";
    return (
      <li className={cx(classes, "sp-row-two", conflict && "sp-row-conflict")} data-row-id={doc.id}>
        <div className="sp-line">
          {check}
          <Name doc={doc} ctx={ctx} />
          {entry.live ? <LiveWho people={doc.here ?? []} id={doc.id} ctx={ctx} /> : null}
          {edge}
        </div>
        <div className={cx("sp-line sp-line-2", !boxed && "sp-line-flush")}>
          {pill}
          {doc.reason ? <span className="sp-reason">{statusClipReason(doc.reason)}</span> : conflict ? null : <Faces people={doc.people} id={doc.id} kind={doc.asksYou ? "asked" : "worked"} ctx={ctx} />}
          {button}
        </div>
      </li>
    );
  }
  return (
    <li className={cx(classes, "sp-row-one", entry.live && "sp-row-live")} data-row-id={doc.id}>
      <div className="sp-line">
        {check}
        <Name doc={doc} ctx={ctx} />
        {entry.live ? <LiveWho people={doc.here ?? []} id={doc.id} ctx={ctx} /> : doc.reason ? <span className="sp-reason">{statusClipReason(doc.reason)}</span> : <Faces people={doc.people} id={doc.id} kind={doc.asksYou ? "asked" : "worked"} ctx={ctx} />}
        {pill ? <span className="sp-pill-slot">{pill}</span> : null}
        {button}
        { }
        {doc.when || more ? edge : null}
      </div>
    </li>
  );
}

export function GroupCard({ entry, ctx, lane }: { entry: Entry; ctx: Ctx; lane: Lane }) {
  const group = entry.item as StatusGroup;
  const [open, setOpen] = useState(ctx.openGroups.has(group.id));

  const [all, setAll] = useState(false);
  const shown = all ? group.members.length : DRAW_LIMIT;
  const rest = group.members.length - shown;
  const checkable = !ctx.readOnly && ctx.checkables.has(group.id);
  const boxed = ctx.boxes || checkable;
  const button = !ctx.readOnly && group.button && FIX_BUTTONS.includes(group.button) ? <RowButton button={group.button} id={group.id} ctx={ctx} group {...(group.ending ? { ending: true } : {})} /> : null;
  const listId = `${group.id}-members`;
  const count = statusGroupCount(group.members.length, ctx.noun);

  return (
    <li className={cx("sp-group", entry.open && "sp-row-open", flashClass(group.id, ctx))} data-row-id={group.id}>
      <div className={cx("sp-row sp-group-row", button && "sp-row-two")}>
        <div className={cx("sp-line", group.editing && "sp-row-editing")}>
          <Check item={group} ctx={ctx} />
          <button type="button" className={cx("sp-twisty", open && "sp-twisty-open")} aria-expanded={open} aria-controls={listId} aria-label={count} onClick={() => setOpen(!open)}>
            <ChevronIcon />
          </button>
          {group.editing ? (
            <input
              className="sp-name sp-name-input"
              aria-label={GROUP_CARD.name}
              defaultValue={group.name}
              ref={(el) => {
                if (el && el.ownerDocument.activeElement !== el && !el.dataset.focused) {
                  el.dataset.focused = "1";
                  el.focus();
                  el.select();
                }
              }}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              onBlur={(event) => ctx.act({ type: "rename-group", id: group.id, name: event.currentTarget.value.trim() || group.name })}
            />
          ) : (
            <>
              <span className="sp-name" title={group.name}>
                {group.name}
              </span>
              { }
              <span className="sp-group-count">{group.members.length}</span>
            </>
          )}
          {pillRepeatsChip(lane, group.state) ? null : (
            <span className="sp-pill-slot">
              <Pill state={group.state} tipPeople={group.tipPeople} reason={group.reason} autoPublish={group.autoPublish} id={group.id} ctx={ctx} />
            </span>
          )}
          <Edge when={group.when} more={groupMenuItems(group, ctx).length > 0 ? <MoreButton id={group.id} name={group.name} ctx={ctx} /> : null} />
        </div>
        {button ? <div className="sp-line sp-line-2">{button}</div> : null}
      </div>
      {open ? (
        <ul className={cx("sp-members", !boxed && "sp-members-flush")} id={listId} aria-label={STATUS_LABELS.files(group.name)}>
          {group.members.slice(0, shown).map((member) => (
            <li key={member.id} className="sp-member">
              <button type="button" className="sp-name-link" onClick={() => ctx.act({ type: "row", id: member.id, action: "open" })}>
                {member.name}
              </button>
              {!ctx.readOnly ? <MoreButton id={memberMenuId(member.id)} name={member.name} ctx={ctx} open={(anchor) => ctx.memberMenuFor(group.id, member.id, anchor)} /> : null}
            </li>
          ))}
          {rest > 0 ? (
            <li className="sp-more-row">
              <button type="button" className="sp-link sp-show-more" onClick={() => setAll(true)}>
                {statusShowMore(rest)}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
