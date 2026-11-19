import type { ReactNode } from "react";
import { STATUS_CONTROL_TIPS, STATUS_LABELS, STATUS_NO_STEP, STATUS_PILL_WORDS, STATUS_RUNNING, STATUS_TIPS, statusLiveWho, STATUS_OTHER_STEP, statusOtherStepLine, statusWho, type StatusPillState } from "../review-flow";
import { loginsOf, type Checkable } from "./logic";
import type { Tips, TipContent } from "./tips";
import { DotsIcon } from "./icons";
import type { CheckKind, PanelAction, PanelMenuItem, StatusChipKey, StatusDoc, StatusGroup, StatusNoun, StatusPerson, StatusRunning } from "./types";

export interface Ctx {
  noun: StatusNoun;
  readOnly: boolean;
  offline: boolean;

  busy: boolean;

  running: StatusRunning | undefined;

  chip: StatusChipKey;
  checked: ReadonlySet<string>;

  checkables: ReadonlyMap<string, Checkable>;

  kind: CheckKind | null;

  boxes: boolean;

  flash: ReadonlySet<string>;

  flashHeld: boolean;
  openMenuId: string | null;

  openGroups: ReadonlySet<string>;

  toggle: (id: string, shift?: boolean) => void;
  tips: Tips;

  menuFor: (id: string, anchor: HTMLElement) => void;

  memberMenuFor: (group: string, member: string, anchor: HTMLElement) => void;

  openItems: (items: readonly PanelMenuItem[], anchor: HTMLElement, id: string) => void;

  act: (action: PanelAction) => void;
}

export const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");

export function pillTip(state: StatusPillState, tipPeople: readonly string[] = [], reason?: string, asksYou?: boolean, autoPublish?: boolean): TipContent | null {
  const name = STATUS_PILL_WORDS[state];
  switch (state) {
    case "edited":
      return { picture: "ladder", lit: null, name, line: STATUS_TIPS.edited };
    case "draft":
      return { picture: "ladder", lit: "draft", name, line: STATUS_TIPS.draft };
    case "in-review":
      return { picture: "ladder", lit: "in-review", name, line: autoPublish ? STATUS_TIPS.autoPublish : asksYou ? STATUS_TIPS.waitingForYou(tipPeople) : STATUS_TIPS.inReview(tipPeople) };
    case "changes-requested":
      return { picture: "ladder", lit: "in-review", name, line: STATUS_TIPS.changesRequested(tipPeople) };
    case "ready":
      return { picture: "ladder", lit: "ready", name, line: STATUS_TIPS.ready };

    case "out-of-date":
      return { picture: "ladder", lit: "ready", name, line: reason ?? STATUS_TIPS.outOfDate };
    case "changed-in-both":
      return { picture: "ladder", lit: null, name, line: reason ?? STATUS_NO_STEP.changedInBoth.line };
    case "held":
      return { picture: "ladder", lit: null, name, line: reason ?? "" };
    case "published":
    case "deleted":
      return null;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function Pill({ state, tipPeople, reason, asksYou, autoPublish, id, ctx }: { state: StatusPillState; tipPeople?: readonly string[]; reason?: string; asksYou?: boolean; autoPublish?: boolean; id: string; ctx: Ctx }) {
  const word = STATUS_PILL_WORDS[state];
  const tip = pillTip(state, tipPeople, reason, asksYou, autoPublish);
  if (!tip) return <span className={`sp-pill sp-pill-${state}`}>{word}</span>;
  const key = `${id}:pill`;
  return (
    <button type="button" className={`sp-pill sp-pill-${state}`} aria-describedby={ctx.tips.open?.key === key ? ctx.tips.id : undefined} {...ctx.tips.bind(key, tip)} onClick={(event) => ctx.tips.toggle(event.currentTarget, key, tip)}>
      {word}
    </button>
  );
}

export const checkClick = (toggle: Ctx["toggle"], id: string) => (event: { target: unknown; currentTarget: unknown; preventDefault: () => void; shiftKey?: boolean }) => {

  if (event.target === event.currentTarget) event.preventDefault();
  toggle(id, !!event.shiftKey);
};

export function noStepTip(item: StatusDoc | StatusGroup): TipContent {
  const card = (words: { name: string; line: string }): TipContent => ({ picture: "ladder", lit: item.state, name: words.name, line: words.line });
  if (item.kind === "doc" && item.teammate) {
    const step = item.state === "draft" || item.state === "edited" ? "submit" : "publish";
    return card({ name: STATUS_NO_STEP.teammate.name, line: STATUS_NO_STEP.teammate.line(statusWho(loginsOf(item.people)), step) });
  }
  if (item.kind === "doc" && item.bringIn && item.state === "draft") return card(STATUS_NO_STEP.notInVault);
  if (item.kind === "doc" && item.propose && (item.state === "draft" || item.state === "edited")) {
    return card({ name: STATUS_NO_STEP.propose.name, line: STATUS_NO_STEP.propose.line(item.propose) });
  }
  const { state } = item;
  switch (state) {
    case "in-review":
      return card(STATUS_NO_STEP.inReview);
    case "changes-requested":
      return card({
        name: STATUS_NO_STEP.changesRequested.name,
        line: item.tipPeople?.length ? STATUS_TIPS.changesRequested(item.tipPeople) : STATUS_NO_STEP.changesRequested.line,
      });
    case "out-of-date":
      return card(STATUS_NO_STEP.outOfDate);
    case "changed-in-both":
    case "held":
      return card({ name: STATUS_NO_STEP.changedInBoth.name, line: item.reason ?? STATUS_NO_STEP.changedInBoth.line });
    case "deleted":
      return card(STATUS_NO_STEP.deleted);
    case "published":
      return card(STATUS_NO_STEP.published);
    case "draft":
    case "edited":
    case "ready":
    case undefined:
      return card(STATUS_NO_STEP.nothingToSend);
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function Check({ item, ctx }: { item: StatusDoc | StatusGroup; ctx: Ctx }) {
  const { id, name } = item;
  const own = ctx.readOnly ? undefined : ctx.checkables.get(id);
  if (!own) return ctx.boxes ? <DimBox id={id} name={name} tip={noStepTip(item)} ctx={ctx} /> : null;
  if (ctx.kind && own.kind !== ctx.kind) return <DimBox id={id} name={name} tip={{ name: STATUS_OTHER_STEP, line: statusOtherStepLine(own.kind, ctx.kind, ctx.checked.size) }} ctx={ctx} />;
  return (
    <label className="sp-check-hit" {...ctx.tips.bind(`${id}:check`, STATUS_CONTROL_TIPS.select)} onClick={checkClick(ctx.toggle, id)}>
      <input type="checkbox" className="sp-check" aria-label={STATUS_LABELS.select(name)} checked={ctx.checked.has(id)} onChange={() => undefined} />
    </label>
  );
}

function DimBox({ id, name, tip, ctx }: { id: string; name: string; tip: TipContent; ctx: Ctx }) {
  const key = `${id}:check`;
  return (
    <label
      className="sp-check-hit sp-check-dim"
      {...ctx.tips.bind(key, tip)}
      onClick={(event) => {

        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        ctx.tips.toggle(event.currentTarget, key, tip);
      }}
    >
      <input type="checkbox" className="sp-check" aria-label={STATUS_LABELS.select(name)} aria-disabled="true" checked={false} onChange={(event) => ctx.tips.toggle(event.currentTarget.parentElement ?? event.currentTarget, key, tip)} />
    </label>
  );
}

export const buttonsOff = (ctx: Pick<Ctx, "offline" | "busy">): boolean => ctx.offline || ctx.busy;

export const runningLabel = (ctx: Pick<Ctx, "busy" | "running">, step: StatusRunning, label: string): string => (ctx.busy && ctx.running === step ? STATUS_RUNNING[step] : label);

export function MoreButton({ id, name, ctx, open }: { id: string; name: string; ctx: Ctx; open?: (anchor: HTMLElement) => void }) {
  return (
    <button
      type="button"
      className="sp-more"
      aria-label={STATUS_LABELS.more(name)}
      aria-haspopup="menu"
      aria-expanded={ctx.openMenuId === id}
      data-sp-menu={id}
      {...ctx.tips.bind(`${id}:more`, STATUS_CONTROL_TIPS.more)}
      onClick={(event) => {

        ctx.tips.hide();
        (open ?? ((anchor: HTMLElement) => ctx.menuFor(id, anchor)))(event.currentTarget);
      }}
    >
      <DotsIcon />
    </button>
  );
}

export function Face({ login, url }: { login: string; url?: string }) {
  return url ? <img className="sp-face" src={url} alt="" /> : <span className="sp-face sp-face-letter" aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>;
}

export function othersOf(people: readonly (string | StatusPerson)[]): StatusPerson[] {
  return people.map((one) => (typeof one === "string" ? { login: one } : one)).filter((one) => one.login !== "you");
}

export type FacesKind = "live" | "asked" | "worked";

export function Faces({ people, id, kind, ctx }: { people: readonly (string | StatusPerson)[]; id: string; kind: FacesKind; ctx: Ctx }) {
  const logins = othersOf(people).map((one) => one.login);
  if (logins.length === 0) return null;
  const tip: TipContent = { picture: kind === "live" ? "join" : "changes", name: logins.join(", "), line: kind === "live" ? STATUS_TIPS.live(logins.length) : kind === "asked" ? STATUS_TIPS.asked : STATUS_TIPS.worked };
  return (
    <span className="sp-who" tabIndex={0} role="group" aria-label={logins.join(", ")} {...ctx.tips.bind(`${id}:faces`, tip)}>
      {statusLiveWho(logins)}
    </span>
  );
}

export function LiveWho({ people, id, ctx }: { people: readonly (string | StatusPerson)[]; id: string; ctx: Ctx }) {
  const logins = othersOf(people).map((one) => one.login);
  if (logins.length === 0) return null;

  const tip: TipContent = { picture: "join", name: logins.join(", "), line: STATUS_TIPS.live(logins.length) };
  return (
    <span className="sp-live-who" tabIndex={0} role="group" aria-label={logins.join(", ")} {...ctx.tips.bind(`${id}:faces`, tip)}>
      <span className="sp-live-dot" aria-hidden="true" />
      <span className="sp-live-names">{statusLiveWho(logins)}</span>
    </span>
  );
}

export function Edge({ when, more, open }: { when?: string; more: ReactNode; open?: boolean }) {
  return (
    <span className={cx("sp-edge", !more && "sp-edge-no-more", Boolean(more) && open && "sp-edge-open")}>
      {when ? <span className="sp-when">{when}</span> : null}
      {more}
    </span>
  );
}
