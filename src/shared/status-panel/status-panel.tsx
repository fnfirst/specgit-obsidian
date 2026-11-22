import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GROUP_CARD,
  STATUS_BAR,
  STATUS_CHIPS,
  STATUS_EMPTY,
  STATUS_FAILED,
  STATUS_LABELS,
  STATUS_OFFLINE,
  STATUS_RETRY,
  STATUS_SLOW,
  STATUS_SELECT_ALL,
  STATUS_SEPARATE,
  STATUS_CHIP_TIPS,
  STATUS_CONTROL_TIPS,
  STATUS_TIPS,
  STATUS_TITLE,
  STATUS_VIEW_ONLY,
  statusBulkResult,
  statusDiscard,
  statusShowMore,
  statusApproveLabel,
  statusPublishLabel,
  statusSubmitLabel,
  type StatusGroupMenuItem,
} from "../review-flow";
import { CloseIcon } from "./icons";
import { FoldRow } from "./folds";
import { DRAW_LIMIT, asksBeforeSubmit, checkablesOf, layoutOf, loginsOf, selectionOf, type Checkable, type Entry } from "./logic";
import { ConfirmDialog, MenuPopover, placeMenu, type OpenMenu } from "./overlays";
import { PINNED_MENU_LABEL, PinnedCard, type CardButton } from "./pinned";
import { GroupCard, Row, groupMenuItems, groupMenuLabel, memberMenuId, rowMenuItems, rowMenuLabel } from "./rows";
import { boxesWait, buttonsOff, cx, runningLabel, type Ctx } from "./shared";
import { SubmitStep } from "./submit-step";
import { TipCard, useTips, type TipContent } from "./tips";
import type { ConfirmQuestion, Lane, PanelAction, PanelHost, PanelMenuItem, StatusChipKey, StatusNotice, StatusPanelModel, StatusRowMenuItem } from "./types";

const NOTICE_MS = 4000;
const FLASH_MS = 1000;

const laneWord = (lane: Exclude<Lane, "none">): string => STATUS_CHIPS[lane];
const CARD_OWN_STEPS: readonly StatusRowMenuItem[] = ["open", "show-changes", "submit-only", "publish-only"];
const GROUP_CARD_ITEMS: readonly StatusGroupMenuItem[] = ["add-reviewer", "move-back", "stop-review"];
const CHIP_LANES = ["approve", "publish", "drafts"] as const;

function useCoarse(): boolean {
  const [coarse, setCoarse] = useState(false);
  useLayoutEffect(() => {
    const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null;
    if (!query) return;
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return coarse;
}

export const SLOW_LOOK_MS = 8_000;

function SkeletonRows() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_LOOK_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <>
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="sp-skeleton" />
      ))}
      {slow ? (
        <p className="sp-state" role="status" data-testid="sp-slow">
          {STATUS_SLOW}
        </p>
      ) : null}
    </>
  );
}

function Skeleton() {
  return (
    <div className="sp-root" aria-busy="true" data-testid="sp-panel">
      <div className="sp-list">
        <SkeletonRows />
      </div>
    </div>
  );
}

export function StatusPanel({ model, host }: { model: StatusPanelModel; host: PanelHost }) {
  if (model.loading && !model.pinned) return <Skeleton />;
  return <Loaded model={model} host={host} />;
}

function Loaded({ model, host }: { model: StatusPanelModel; host: PanelHost }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const noun = host.noun;
  const pointerCoarse = useCoarse();
  const coarse = pointerCoarse || host.touch === true;
  const tips = useTips(rootRef);
  const layout = useMemo(() => layoutOf(model), [model]);
  const [chip, setChip] = useState<StatusChipKey>(() => model.start?.chip ?? "all");
  const [checkedRaw, setCheckedRaw] = useState<ReadonlySet<string>>(() => new Set(model.checked));
  const [shownAll, setShownAll] = useState<ReadonlySet<string>>(() => new Set());
  const [step, setStep] = useState<{ ids: readonly string[]; documents: number } | null>(() => (model.start?.step ? { ids: [...model.checked], documents: model.checked.length } : null));
  const [menu, setMenu] = useState<(OpenMenu & { id: string }) | null>(null);
  const [dialog, setDialog] = useState<{ question: ConfirmQuestion; resolve: (id: string) => void } | null>(null);
  const [shutFor, setShutFor] = useState<StatusNotice | null>(null);
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set(model.start?.flash ?? []));
  const flashHeld = (model.start?.flash?.length ?? 0) > 0;
  const lastChecked = useRef<string | null>(null);
  const previousLanes = useRef<ReadonlyMap<string, Lane> | null>(null);

  const checkables = useMemo(() => checkablesOf(layout, chip), [layout, chip]);
  const checked = useMemo(() => new Set([...checkedRaw].filter((id) => checkables.has(id))), [checkedRaw, checkables]);
  const selection = useMemo(() => selectionOf(checkables, checked), [checkables, checked]);
  const order = useMemo(() => [...checkables.keys()], [checkables]);
  const kind = selection.checked[0]?.kind ?? null;
  const { onAction, onChecked } = model;
  const act = useCallback((action: PanelAction): void => void onAction(action), [onAction]);

  const touched = useRef(false);
  const startKey = model.checked.join("\n");
  useEffect(() => {
    if (!touched.current) setCheckedRaw(new Set(startKey === "" ? [] : startKey.split("\n")));
  }, [startKey]);
  const setChecked = useCallback(
    (next: Set<string>) => {
      touched.current = true;
      setStep(null);
      setCheckedRaw(next);
      onChecked?.([...next]);
    },
    [onChecked],
  );
  const joinedIds = useMemo(() => new Set(model.items.flatMap((item) => (item.kind === "group" ? item.members.map((member) => member.id) : []))), [model.items]);
  useEffect(() => {
    if (![...checkedRaw].some((id) => joinedIds.has(id))) return;
    const next = new Set([...checkedRaw].filter((id) => !joinedIds.has(id)));
    setCheckedRaw(next);
    if (touched.current) onChecked?.([...next]);
  }, [joinedIds, checkedRaw, onChecked]);
  const wasDeleted = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const deleted = new Set(model.items.flatMap((item) => (item.kind === "doc" && item.state === "deleted" ? [item.id] : [])));
    const before = wasDeleted.current;
    wasDeleted.current = deleted;
    if (!before) return;
    const turned = [...deleted].filter((id) => !before.has(id) && checkedRaw.has(id));
    if (turned.length === 0) return;
    const next = new Set([...checkedRaw].filter((id) => !turned.includes(id)));
    setCheckedRaw(next);
    onChecked?.([...next]);
    setStep((now) => (now && now.ids.some((id) => turned.includes(id)) ? null : now));
  }, [model.items, checkedRaw, onChecked]);
  const pickChip = useCallback(
    (key: StatusChipKey) => {
      setChip(key);
      const shown = checkablesOf(layout, key);
      const kept = [...checked].filter((id) => shown.has(id));
      if (kept.length !== checked.size) setChecked(new Set(kept));
    },
    [checked, layout, setChecked],
  );
  const wait = boxesWait({ busy: !!model.busy, running: model.running });
  const toggle = useCallback(
    (id: string, shift?: boolean) => {
      if (wait) return;
      const own = checkables.get(id);
      if (!own) return;
      const next = new Set(checked);
      const willCheck = !next.has(id);
      const step = kind ?? own.kind;
      if (willCheck && own.kind !== step) return;
      const from = lastChecked.current ? order.indexOf(lastChecked.current) : -1;
      const to = order.indexOf(id);
      if (shift && from >= 0 && to >= 0) {
        for (const one of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (!willCheck) next.delete(one);
          else if (checkables.get(one)?.kind === step) next.add(one);
        }
      } else if (willCheck) next.add(id);
      else next.delete(id);
      lastChecked.current = id;
      setChecked(next);
    },
    [checkables, checked, kind, wait, order, setChecked],
  );

  const laneMap = useMemo(() => new Map(layout.entries.map((entry) => [entry.item.id, entry.lane] as const)), [layout]);
  useEffect(() => {
    const before = previousLanes.current;
    previousLanes.current = laneMap;
    if (!before) return;
    const moved = [...laneMap].filter(([id, lane]) => before.has(id) && before.get(id) !== lane).map(([id]) => id);
    if (moved.length === 0) return;
    setFlash(new Set(moved));
    const timer = window.setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [laneMap]);

  const notice = model.notice && shutFor !== model.notice ? model.notice : null;
  useEffect(() => {
    if (!notice || notice.needs > 0 || model.start?.holdNotice) return;
    const timer = window.setTimeout(() => setShutFor(notice), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, model.start?.holdNotice]);

  const ownConfirm = useCallback((question: ConfirmQuestion) => new Promise<string>((resolve) => setDialog({ question, resolve })), []);
  const ask = useCallback((question: ConfirmQuestion) => {
    tips.hide();
    return (host.confirm ?? ownConfirm)(question);
  }, [host.confirm, ownConfirm, tips]);

  const openMenu = useCallback(
    (items: readonly PanelMenuItem[], anchor: HTMLElement, id = "") => {
      if (items.length === 0) return;
      if (host.openMenu) host.openMenu(items, anchor);
      else setMenu({ items, anchor, id, ...placeMenu(rootRef.current, anchor, items.length) });
    },
    [host],
  );

  const runStepItem = useCallback(
    (item: string, id: string, documents: number, other: () => void) => (item === "submit-only" ? setStep({ ids: [id], documents }) : item === "publish-only" ? act({ type: "publish", ids: [id] }) : other()),
    [act],
  );
  const itemsFor = useCallback(
    (id: string): PanelMenuItem[] => {
      const row = layout.entries.find((entry) => entry.item.id === id)?.item;
      if (row?.kind === "doc") {
        return rowMenuItems(row, { noun, readOnly: !!model.readOnly }).map((item) => ({ label: rowMenuLabel(item), run: () => runStepItem(item, id, 1, () => act({ type: "row", id, action: item })) }));
      }
      if (row?.kind === "group") {
        return groupMenuItems(row, { readOnly: !!model.readOnly }).map((item: StatusGroupMenuItem) => ({ label: groupMenuLabel(item), run: () => runStepItem(item, id, row.members.length, () => act({ type: "group", id, action: item })) }));
      }
      return [];
    },
    [act, layout, model.readOnly, noun, runStepItem],
  );

  const ctx: Ctx = {
    noun,
    readOnly: !!model.readOnly,
    offline: !!model.offline,
    busy: !!model.busy,
    running: model.running,
    chip,
    checked,
    checkables,
    kind,
    boxes: !model.readOnly && checkables.size > 0,
    flash,
    flashHeld,
    openMenuId: menu?.id ?? null,
    openGroups: new Set(model.start?.openGroups ?? []),
    toggle,
    tips,
    menuFor: (id, anchor) => openMenu(itemsFor(id), anchor, id),
    openItems: (items, anchor, id) => openMenu(items, anchor, id),
    memberMenuFor: (group, member, anchor) => openMenu(model.readOnly ? [] : [{ label: GROUP_CARD.takeOut, run: () => act({ type: "take-out", group, id: member }) }], anchor, memberMenuId(member)),
    act,
  };

  const things: readonly Checkable[] = selection.checked;
  const submitFlow = useCallback(async () => {
    if (asksBeforeSubmit(things)) {
      const count = things.length;
      const canGroup = !model.groupsOff && !model.grouping;
      const choice = await ask({
        title: STATUS_SEPARATE.title(count),
        choices: [...(canGroup ? [{ id: "group", label: STATUS_SEPARATE.group }] : []), { id: "submit", label: STATUS_SEPARATE.submit(count), primary: true }],
      });
      if (choice === "group") {
        const ids = things.filter((one) => !one.isGroup).map((one) => one.id);
        const answer = await onAction({ type: "group-together", ids });
        if (answer && typeof answer.groupId === "string") setStep({ ids: [answer.groupId], documents: ids.length });
        return;
      }
      if (choice !== "submit") return;
    }
    setStep({ ids: things.map((one) => one.id), documents: selection.documents });
  }, [act, ask, model.groupsOff, model.grouping, selection.documents, things]);

  const onCardButton = (button: CardButton) => {
    const id = layout.pinned?.id ?? "";
    if (button === "submit") setStep({ ids: [id], documents: 1 });
    else if (button === "approve") act({ type: "approve", ids: [id] });
    else if (button === "publish") act({ type: "publish", ids: [id] });
    else if (button === "propose") act({ type: "pinned", action: "propose" });
    else act({ type: "pinned", action: "ask-changes" });
  };

  const cardMenuItems = (): PanelMenuItem[] => {
    const open = layout.pinned;
    if (!open) return [];
    const ownItems = open.menu ?? [];
    const before = ownItems.filter((item) => item !== "view-on-github").map((item): PanelMenuItem => ({ label: PINNED_MENU_LABEL[item], run: () => act({ type: "pinned", action: item }) }));
    const after = ownItems.filter((item) => item === "view-on-github").map((item): PanelMenuItem => ({ label: PINNED_MENU_LABEL[item], run: () => act({ type: "pinned", action: item }) }));
    if (!model.cardOnly && !open.reviewMenu) return [...before, ...after];
    const ownNames = new Set<string>(ownItems);
    const openEntry = layout.entries.find((entry) => entry.open);
    let derived: PanelMenuItem[] = [];
    if (openEntry?.item.kind === "doc") {
      const row = openEntry.item;
      derived = rowMenuItems(row, { noun, readOnly: !!model.readOnly })
        .filter((item) => item !== "view-on-github" && !CARD_OWN_STEPS.includes(item) && !ownNames.has(item))
        .map((item): PanelMenuItem => ({ label: rowMenuLabel(item), run: () => act({ type: "row", id: row.id, action: item }) }));
    } else if (openEntry?.item.kind === "group") {
      const group = openEntry.item;
      derived = groupMenuItems(group, { readOnly: !!model.readOnly })
        .filter((item) => GROUP_CARD_ITEMS.includes(item) && !ownNames.has(item))
        .map((item): PanelMenuItem => ({ label: groupMenuLabel(item), run: () => act({ type: "group", id: group.id, action: item }) }));
    }
    return [...before, ...derived, ...after];
  };
  const cardMenu = cardMenuItems();
  const onCardMore = (anchor: HTMLElement) => openMenu(cardMenu, anchor, "pinned");

  const dimGroup: TipContent = { picture: "group", name: STATUS_BAR.group, line: STATUS_TIPS.groupTogether(noun), reason: model.grouping?.reason ?? STATUS_BAR.groupReason(noun), ...(model.grouping?.link ? { link: model.grouping.link } : {}) };
  const liveGroup: TipContent = { picture: "group", name: STATUS_BAR.group, line: STATUS_TIPS.groupTogether(noun) };

  const start = model.start;
  const started = useRef(false);
  useEffect(() => {
    if (!start || started.current) return;
    started.current = true;
    if (start.askSeparate) void submitFlow();
    const root = rootRef.current;
    if (start.menu && root) {
      const anchor = root.querySelector<HTMLElement>(`[data-sp-menu="${start.menu}"]`);
      if (anchor) anchor.click();
    }
    if (start.tip && root) {
      const anchor = root.querySelector<HTMLElement>(`[data-sp-tip="${start.tip}"]`);
      if (anchor && start.tip.endsWith(":faces")) {
        const logins = loginsOf(layout.entries.find((entry) => `${entry.item.id}:faces` === start.tip)?.item.here);
        tips.openAt(anchor, start.tip, { picture: "join", name: logins.join(", "), line: STATUS_TIPS.live(logins.length) });
      }
      else if (anchor) anchor.click();
    }
    if (start.scroll && listRef.current) listRef.current.scrollTop = start.scroll;
  }, []);

  const stepChip = chip !== "all" && chip !== "live";
  const ofStep = [...checkables.values()].filter((one) => one.kind === (kind ?? one.kind)).map((one) => one.id);
  const allChecked = ofStep.length > 0 && checked.size === ofStep.length;
  const someChecked = checked.size > 0 && !allChecked;
  const allBox = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = someChecked;
  });

  const groupButton = (() => {
    const { drafts, groups } = selection;
    if (model.groupsOff) return null;
    if (chip !== "drafts" && kind !== "submit") return null;
    if (model.grouping) return { kind: "dim" as const, label: STATUS_BAR.group, run: () => undefined };
    if (drafts.length >= 1 && groups.length === 1) {
      const target = groups[0]!;
      return { kind: "add" as const, label: STATUS_BAR.addTo(drafts.length, target.name), run: () => act({ type: "add-to-group", ids: drafts.map((one) => one.id), group: target.id }) };
    }
    if (drafts.length >= 1 && groups.length >= 2) return { kind: "menu" as const, label: STATUS_BAR.addToMenu(drafts.length), run: () => undefined };
    if (drafts.length >= 2 && groups.length === 0) {
      return { kind: "group" as const, label: selection.checked.length === drafts.length ? STATUS_BAR.group : STATUS_BAR.groupCount(drafts.length), run: () => act({ type: "group-together", ids: drafts.map((one) => one.id) }) };
    }
    return { kind: "dim" as const, label: STATUS_BAR.group, run: () => undefined };
  })();

  const onGroupButton = (anchor: HTMLElement) => {
    if (!groupButton) return;
    if (groupButton.kind === "dim") return model.grouping?.retry ? void act({ type: "retry" }) : tips.toggle(anchor, "bar:group", dimGroup);
    if (groupButton.kind === "menu") {
      const ids = selection.drafts.map((one) => one.id);
      tips.hide();
      openMenu(
        [...selection.groups.map((one) => ({ label: one.name, run: () => act({ type: "add-to-group", ids, group: one.id }) })), { label: STATUS_BAR.newGroup, run: () => act({ type: "add-to-group", ids, group: null }) }],
        anchor,
        "bar",
      );
      return;
    }
    groupButton.run();
  };

  const footer = (() => {
    if (step) return null;
    if (model.readOnly) return null;
    if (!kind || selection.documents === 0) return null;
    const label = runningLabel(ctx, kind, (kind === "approve" ? statusApproveLabel : kind === "publish" ? statusPublishLabel : statusSubmitLabel)(selection.documents, false, noun));
    const ids = selection.checked.map((one) => one.id);
    return (
      <div className="sp-footer" data-testid="sp-footer">
        <div className="sp-footer-buttons">
          <button type="button" className="sp-btn sp-primary" disabled={buttonsOff(ctx)} onClick={() => (kind === "submit" ? void submitFlow() : act({ type: kind, ids }))}>
            {label}
          </button>
        </div>
        {noun === "note" && selection.discardCount > 0 ? (
          <button type="button" className="sp-link sp-discard" disabled={buttonsOff(ctx)} onClick={() => act({ type: "discard", ids: selection.discardable.map((one) => one.id) })}>
            {statusDiscard(selection.discardCount, noun)}
          </button>
        ) : null}
      </div>
    );
  })();

  const renderEntry = (entry: Entry, laneChip: Lane) =>
    entry.item.kind === "group" ? <GroupCard key={entry.item.id} entry={entry} ctx={ctx} lane={laneChip} /> : <Row key={entry.item.id} entry={entry} ctx={ctx} lane={laneChip} />;

  const rowsOf = (entries: readonly Entry[], key: string, laneChip: Lane) => {
    const drawn = shownAll.has(key) ? entries : entries.slice(0, DRAW_LIMIT);
    const rest = entries.length - drawn.length;
    return (
      <ul className="sp-rows">
        {drawn.map((entry) => renderEntry(entry, laneChip))}
        {rest > 0 ? (
          <li className="sp-more-row">
            <button type="button" className="sp-link sp-show-more" onClick={() => setShownAll(new Set(shownAll).add(key))}>
              {statusShowMore(rest)}
            </button>
          </li>
        ) : null}
      </ul>
    );
  };

  const chips: { key: StatusChipKey; label: string; count?: number }[] = [
    { key: "all", label: STATUS_CHIPS.all },
    ...(layout.live.length > 0 ? [{ key: "live" as const, label: STATUS_CHIPS.live, count: layout.live.length }] : []),
    ...CHIP_LANES.flatMap((lane) => (layout.counts[lane] > 0 ? [{ key: lane, label: laneWord(lane), count: layout.counts[lane] }] : [])),
  ];

  const onListKey = (event: { key: string; shiftKey: boolean; target: EventTarget | null; preventDefault: () => void }) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== " ") return;
    const target = event.target as HTMLElement | null;
    const li = target?.closest?.<HTMLElement>("li[data-row-id]");
    if (!target || !li || !listRef.current) return;
    const id = li.getAttribute("data-row-id") ?? "";
    if (event.key === " ") {
      if (target.tagName === "INPUT" || !checkables.has(id)) return;
      event.preventDefault();
      toggle(id, event.shiftKey);
      return;
    }
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>("li[data-row-id]"));
    const next = rows[rows.indexOf(li) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    if (event.shiftKey) {
      const more = new Set(checked);
      const step = kind ?? checkables.get(id)?.kind;
      for (const one of [id, next.getAttribute("data-row-id") ?? ""]) if (checkables.get(one)?.kind === step) more.add(one);
      lastChecked.current = next.getAttribute("data-row-id");
      if (!wait) setChecked(more);
    }
    (next.querySelector<HTMLElement>(".sp-check") ?? next.querySelector<HTMLElement>(".sp-name-link, .sp-name"))?.focus();
  };

  const foldRows =
    model.folds && model.folds.length > 0 ? (
      <div className="sp-folds">
        {model.folds.map((fold) => (
          <FoldRow key={fold.id} fold={fold} ctx={ctx} />
        ))}
      </div>
    ) : null;

  const cardOnly = !!model.cardOnly;
  const quiet = !cardOnly && checked.size > 0;
  const card = layout.pinned ? <PinnedCard pinned={layout.pinned} ctx={ctx} quiet={quiet} hasMore={cardMenu.length > 0} onButton={onCardButton} onMore={onCardMore} /> : null;
  const failed = (
    <div className="sp-state">
      <p>{STATUS_FAILED}</p>
      <button type="button" className="sp-btn" onClick={() => act({ type: "retry" })}>
        {STATUS_RETRY}
      </button>
    </div>
  );
  const openCommentsOf = (ids: readonly string[]): number =>
    ids.reduce((sum, id) => sum + ((layout.pinned?.id === id ? layout.pinned.openComments : layout.entries.find((entry) => entry.item.id === id)?.item.openComments) ?? 0), 0);

  return (
    <div ref={rootRef} className={cx("sp-root", coarse && "sp-coarse")} data-testid="sp-panel" aria-label={STATUS_TITLE} aria-busy={model.busy || model.loading ? true : undefined}>
      {model.offline ? (
        <div className="sp-band sp-offline" role="status">
          {STATUS_OFFLINE}
        </div>
      ) : null}
      {notice ? (
        <div className="sp-band sp-notice" role="status">
          <span>{statusBulkResult(notice.done, notice.did, notice.needs)}</span>
          <button type="button" className="sp-icon-button" aria-label={STATUS_LABELS.close} onClick={() => setShutFor(notice)}>
            <CloseIcon />
          </button>
        </div>
      ) : null}
      <div className="sp-list" ref={listRef} onKeyDown={onListKey}>
        {cardOnly ? (
          card
        ) : model.loading ? (
          <>
            {card}
            <SkeletonRows />
          </>
        ) : model.loadFailed ? (
          <>
            {card}
            {failed}
          </>
        ) : layout.empty ? (
          <>
            <p className="sp-state">{STATUS_EMPTY}</p>
            {foldRows}
          </>
        ) : (
          <>
            {card}
            {chips.length > 1 ? (
            <div className="sp-chip-row" role="group" aria-label={STATUS_TITLE}>
              {chips.map((one) => {
                const active = chip === one.key;
                return (
                  <button key={one.key} type="button" className={cx("sp-chip-btn", active && "sp-chip-on")} aria-pressed={active} {...(one.key === "approve" || one.key === "publish" || one.key === "drafts" ? tips.bind(`chip:${one.key}`, { name: one.label, line: STATUS_CHIP_TIPS[one.key] }) : one.key === "all" ? tips.bind("chip:all", STATUS_CONTROL_TIPS.all) : {})} onClick={() => pickChip(one.key)}>
                    {one.key === "live" ? <span className="sp-live-dot" aria-hidden="true" /> : null}
                    <span>{one.label}</span>
                    {one.count !== undefined ? (
                      <>
                        {" "}
                        <span className="sp-chip-count">{one.count}</span>
                      </>
                    ) : null}
                  </button>
                );
              })}
            </div>
            ) : null}
            {model.readOnly && !layout.pinned ? <p className="sp-view-only">{STATUS_VIEW_ONLY}</p> : null}
            {!model.readOnly && checkables.size > 0 && (stepChip || checked.size > 0) ? (
              <div className="sp-bar" data-testid="sp-bar">
                <label
                  className={cx("sp-check-hit", wait && "sp-check-wait")}
                  onClick={(event) => {
                    if (event.target !== allBox.current) event.preventDefault();
                    if (wait) return;
                    setChecked(allChecked ? new Set() : new Set(ofStep));
                  }}
                >
                  <input ref={allBox} type="checkbox" className="sp-check" aria-label={STATUS_LABELS.selectAll} aria-disabled={wait ? "true" : undefined} checked={allChecked} onChange={() => undefined} />
                  <span className="sp-bar-count">{STATUS_SELECT_ALL}</span>
                </label>
                {groupButton ? (
                  groupButton.kind === "dim" ? (
                    <button type="button" className="sp-link sp-bar-dim" aria-disabled="true" data-sp-menu="bar" {...tips.bind("bar:group", dimGroup)} onClick={(event) => (model.grouping?.retry ? act({ type: "retry" }) : tips.toggle(event.currentTarget, "bar:group", dimGroup))}>
                      {groupButton.label}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="sp-btn"
                      aria-disabled={buttonsOff(ctx) ? "true" : undefined}
                      aria-haspopup={groupButton.kind === "menu" ? "menu" : undefined}
                      data-sp-menu="bar"
                      {...tips.bind("bar:group", liveGroup)}
                      onClick={(event) => (buttonsOff(ctx) ? undefined : onGroupButton(event.currentTarget))}
                    >
                      {groupButton.label}
                    </button>
                  )
                ) : null}
              </div>
            ) : null}
            {chip === "all" ? (
              <>
                <section className="sp-section" aria-label={STATUS_CHIPS.all}>
                  {rowsOf(layout.all, "all", "none")}
                </section>
                {foldRows}
              </>
            ) : null}
            {chip === "live" ? (
              <section className="sp-section" aria-label={STATUS_CHIPS.live}>
                {rowsOf(layout.live, "live", "none")}
              </section>
            ) : null}
            {stepChip ? (
              <section className="sp-section" aria-label={laneWord(chip)}>
                {rowsOf(layout.byLane[chip], `step:${chip}`, chip)}
              </section>
            ) : null}
          </>
        )}
      </div>
      {step ? (
        <SubmitStep
          ids={step.ids}
          reviewers={model.reviewers ?? []}
          documents={step.documents}
          openComments={openCommentsOf(step.ids)}
          ctx={ctx}
          onBack={() => setStep(null)}
          onSubmit={() => {
            act({ type: "submit", ids: step.ids, reviewers: (model.reviewers ?? []).map((one) => one.login) });
            setStep(null);
          }}
        />
      ) : cardOnly ? null : (
        footer
      )}
      {tips.open ? <TipCard tip={tips.open} id={tips.id} root={rootRef} /> : null}
      {menu ? <MenuPopover menu={menu} onClose={() => setMenu(null)} /> : null}
      {dialog ? (
        <ConfirmDialog
          question={dialog.question}
          onChoose={(id) => {
            dialog.resolve(id);
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
