import { APPROVE_IN_SPECGIT, STATUS_CARD, STATUS_CONTROL_TIPS, STATUS_LABELS, STATUS_PINNED, STATUS_REVIEWER_MARK, STATUS_TIPS, STATUS_VIEW_ONLY, statusApproveLabel, statusHere, statusPeopleHere, statusProposeLabel, statusPublishLabel, statusSubmitLabel } from "../review-flow";
import { CheckIcon, DotsIcon } from "./icons";
import { buttonsOff, cx, Face, othersOf, Pill, runningLabel, type Ctx } from "./shared";
import type { PinnedMenuItem, StatusPinned } from "./types";

export type CardButton = "propose" | "submit" | "approve" | "ask-changes" | "publish";

export const PINNED_MENU_LABEL: Record<PinnedMenuItem, string> = { "open-in-specgit": STATUS_CARD.openInSpecgit, "copy-link": STATUS_CARD.copyLink, "view-on-github": STATUS_CARD.viewOnGitHub };

export function cardButtons(pinned: Pick<StatusPinned, "state" | "asksYou" | "canApprove" | "publishable" | "propose" | "approveInSpecgit" | "local" | "nothingToSend">): CardButton[] {
  if (pinned.local) return [];
  const reviewer: CardButton[] | null = pinned.state === "in-review" && (pinned.asksYou || pinned.canApprove) ? (pinned.approveInSpecgit ? ["approve"] : ["approve", "ask-changes"]) : null;
  if (pinned.nothingToSend) return reviewer ?? [];
  const unsent = pinned.state === "draft" || pinned.state === "edited";
  if (pinned.propose && unsent) return ["propose"];
  if (unsent) return ["submit"];
  if (reviewer) return reviewer;
  if (pinned.state === "ready") return ["publish"];
  if ((pinned.state === "in-review" || pinned.state === "changes-requested") && pinned.publishable) return ["publish"];
  return [];
}

function liveControl(plugin: NonNullable<StatusPinned["plugin"]>): { label: string; tip: { name: string; line: string } | null } {
  if (plugin.joining) return { label: STATUS_CARD.connecting, tip: null };
  const action = plugin.action ?? (plugin.connected ? "disconnect" : "connect");
  switch (action) {
    case "work-offline":
      return { label: STATUS_CARD.workOffline, tip: STATUS_CONTROL_TIPS.workOffline };
    case "resume-sync":
      return { label: STATUS_CARD.resumeSync, tip: STATUS_CONTROL_TIPS.resumeSync };
    case "disconnect":
      return { label: STATUS_CARD.disconnect, tip: null };
    case "connect":
      return { label: STATUS_CARD.connect, tip: null };
  }
}

export function PinnedCard({ pinned, ctx, quiet, hasMore, showReason = false, onButton, onMore }: { pinned: StatusPinned; ctx: Ctx; quiet: boolean; hasMore: boolean; showReason?: boolean; onButton: (button: CardButton) => void; onMore: (anchor: HTMLElement) => void }) {
  const here = othersOf(pinned.here ?? []);
  const plugin = pinned.plugin;
  const live = plugin ? liveControl(plugin) : null;
  const showTip = { picture: "changes" as const, name: STATUS_PINNED.showChanges, line: STATUS_TIPS.showChanges };
  const buttons = ctx.readOnly ? [] : cardButtons(pinned);
  const label = (button: CardButton): string => {
    switch (button) {
      case "propose":
        return runningLabel(ctx, "propose", statusProposeLabel(pinned.propose ?? ""));
      case "submit":
        return runningLabel(ctx, "submit", statusSubmitLabel(1, true, ctx.noun));
      case "approve":
        return runningLabel(ctx, "approve", pinned.approveInSpecgit ? APPROVE_IN_SPECGIT : statusApproveLabel(1, true, ctx.noun));
      case "publish":
        return runningLabel(ctx, "publish", statusPublishLabel(1, true, ctx.noun));
      default:
        return STATUS_PINNED.askChanges;
    }
  };
  return (
    <section className="sp-pinned" data-testid="sp-pinned">
      <div className="sp-card">
        <div className="sp-pinned-head">
          <span className="sp-name sp-grow">{pinned.name}</span>
          <Pill state={pinned.state} tipPeople={pinned.tipPeople} reason={pinned.reason} asksYou={pinned.asksYou} autoPublish={pinned.autoPublish} approved={pinned.approved} id={pinned.id} ctx={ctx} />
          {hasMore ? (
            <button
              type="button"
              className="sp-more"
              aria-label={STATUS_LABELS.more(pinned.name)}
              aria-haspopup="menu"
              aria-expanded={ctx.openMenuId === "pinned"}
              data-sp-menu="pinned"
              {...ctx.tips.bind(`${pinned.id}:more`, STATUS_CONTROL_TIPS.more)}
              onClick={(event) => {
                ctx.tips.hide();
                onMore(event.currentTarget);
              }}
            >
              <DotsIcon />
            </button>
          ) : null}
        </div>
        {pinned.warning ? (
          <p className="sp-card-warning" role="status" data-testid="sp-card-warning">
            {pinned.warning}
          </p>
        ) : null}
        {showReason && pinned.reason ? (
          <p className="sp-reason sp-card-reason" data-testid="sp-card-reason">
            {pinned.reason}
          </p>
        ) : null}
        {here.length > 0 || plugin ? (
          <div className="sp-pinned-here">
            {here.length > 0 ? (
              <>
                <span className="sp-faces">
                  {here.slice(0, 3).map((one) => (
                    <Face key={one.login} login={one.login} url={one.avatarUrl} />
                  ))}
                </span>
                <span className="sp-grow">{statusHere(here.map((one) => one.login))}</span>
              </>
            ) : plugin && !plugin.connected && (plugin.people ?? 0) > 0 ? (
              <span className="sp-grow">{statusPeopleHere(plugin.people ?? 0)}</span>
            ) : null}
            {plugin && live ? (
              <button
                type="button"
                className={cx("sp-link sp-live-link", !plugin.connected && "sp-live-connect")}
                disabled={plugin.joining}
                {...(live.tip ? ctx.tips.bind(`${pinned.id}:live`, live.tip) : {})}
                onClick={() => {
                  ctx.tips.hide();
                  ctx.act({ type: "pinned", action: plugin.connected ? "disconnect" : "connect-live" });
                }}
              >
                {live.label}
              </button>
            ) : null}
          </div>
        ) : null}
        {pinned.state !== "published" && !pinned.hideChanges ? (
          <div className="sp-switch-row">
            <span {...ctx.tips.bind(`${pinned.id}:changes`, showTip)}>{STATUS_LABELS.showChanges}</span>
            <button type="button" role="switch" className="sp-switch" aria-checked={pinned.showChanges} aria-label={STATUS_LABELS.showChanges} {...ctx.tips.bind(`${pinned.id}:changes`, showTip)} onClick={() => ctx.act({ type: "show-changes", on: !pinned.showChanges })}>
              <span className="sp-switch-knob" />
            </button>
          </div>
        ) : null}
        {pinned.reviewers ? (
          <div className="sp-chips">
            {pinned.reviewers.map((one) => (
              <span key={one.login} className="sp-chip" aria-label={one.mark ? `${one.login}, ${STATUS_REVIEWER_MARK[one.mark]}` : one.login}>
                <Face login={one.login} url={one.avatarUrl} />
                <span>{one.login}</span>
                {one.mark === "approved" ? (
                  <span className="sp-mark sp-mark-approved">
                    <CheckIcon />
                  </span>
                ) : null}
                {one.mark === "changes" ? <span className="sp-mark sp-mark-changes" /> : null}
              </span>
            ))}
            <button type="button" className="sp-chip sp-chip-add" disabled={buttonsOff(ctx) || ctx.readOnly} onClick={() => ctx.act({ type: "pinned", action: "add-reviewer" })}>
              {STATUS_PINNED.add}
            </button>
          </div>
        ) : null}
        {ctx.readOnly ? (
          <p className="sp-view-only">{STATUS_VIEW_ONLY}</p>
        ) : (
          <>
            {pinned.state === "out-of-date" && !pinned.fixBelow ? (
              <div className="sp-card-actions">
                <button type="button" className="sp-btn sp-primary" disabled={buttonsOff(ctx)} onClick={() => ctx.act({ type: "pinned", action: "catch-up" })}>
                  {STATUS_PINNED.catchUp}
                </button>
              </div>
            ) : null}
            {pinned.step === "choose" && !pinned.fixBelow ? (
              <div className="sp-card-actions">
                <button type="button" className="sp-btn sp-primary" disabled={buttonsOff(ctx)} onClick={() => ctx.act({ type: "pinned", action: "choose" })}>
                  {STATUS_PINNED.choose}
                </button>
              </div>
            ) : null}
            {buttons.length > 0 && !quiet ? (
              <>
                {buttons.includes("publish") && pinned.note ? (
                  <p className="sp-card-note" data-testid="sp-card-note">
                    {pinned.note}
                  </p>
                ) : null}
                <div className="sp-card-actions">
                  {buttons.map((button, index) => (
                    <button key={button} type="button" className={cx("sp-btn", index === 0 && "sp-primary")} disabled={buttonsOff(ctx)} onClick={() => onButton(button)}>
                      {label(button)}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
