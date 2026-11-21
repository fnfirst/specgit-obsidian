import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { CommentsTab, type CommentsTabEnv } from "../comments/tab";
import { EmptyState, Icon, Mark, Wordmark } from "../brand/parts";
import { Tip, useTipOpen, useTipTouch } from "../brand/tip";
import { STATUS_CONTROL_TIPS } from "../shared/review-flow";
import type { OnboardState } from "../onboard/flow";
import { ChooseRepository, OnboardProgress, type OnboardActions, Welcome } from "./states";
import { StayControl } from "./stay-control";
import { cameInWords } from "../disk/regions";
import { isNotLive, type NoteWord, phaseOf, wordFor } from "../status";
import { FILE_WORDS, outsideFolderWords } from "../pick/words";
import type { PanelModel, PanelState, TabId } from "./model";
import { NEVER, useWatch } from "./use-watch";
import { NOT_LIVE } from "../review/words";
import type { StatusView } from "../status/controller";

export interface OnboardingWatch {
  state: () => OnboardState;
  subscribe: (listener: () => void) => () => void;
}

const IDLE: OnboardState = { kind: "idle" };

export interface PanelActions extends OnboardActions {
  onboarding?: OnboardingWatch;
  connect: (path: string) => void;
  disconnect: (path: string) => void;
  signIn: () => void;
  chooseRepository: () => void;
  openInSpecgit: (path: string) => void;
  copyLink: (path: string) => void;
  seeChanges: (path: string) => void;
  setStayConnected: (on: boolean) => void;
  repo?: () => string;
  tryNow?: () => void;
}

export type { TabId };

export interface TabBadges {
  comments: { open: number };
}

export const NO_BADGES: TabBadges = { comments: { open: 0 } };

const ALL_TABS: ReadonlyArray<{ id: TabId; label: string; icon: string }> = [
  { id: "status", label: "Status", icon: "activity" },
  { id: "comments", label: "Comments", icon: "message-square" },
];

function useModel(model: PanelModel): PanelState {
  const [state, setState] = useState(model.state());
  useEffect(() => {
    setState(model.state());
    return model.subscribe(() => setState(model.state()));
  }, [model]);
  return state;
}

export interface PanelComments {
  env: CommentsTabEnv;
  tabs?: PanelTabs;
}

export type TabContents = Partial<Record<TabId, ComponentChildren>>;
export interface PanelTabs {
  contents: (view?: StatusView) => TabContents;
  badges: () => TabBadges;
  subscribe: (listener: () => void) => () => void;
}

export function Panel({ model, actions, badges = NO_BADGES, comments }: { model: PanelModel; actions: PanelActions; badges?: TabBadges; comments: PanelComments }) {
  const state = useModel(model);
  const { note, cameIn } = state;
  const tab = useWatch(model.subscribe, model.tab);
  const ids = useId();
  const open = useWatch(comments.env.hub.subscribe, () => comments.env.hub.openCount(note?.path ?? null));
  const mine = comments.tabs;
  const own = useWatch(mine?.subscribe ?? NEVER, () => mine?.badges() ?? badges);
  const shown: TabBadges = { ...own, comments: { open } };
  const onboarding = useWatch(actions.onboarding?.subscribe ?? NEVER, () => actions.onboarding?.state() ?? IDLE);
  if (!state.signedIn || !state.mapped) {
    return (
      <div class="specgit-panel">
        <Top repo={state.signedIn ? state.repo : ""}>{note && <p class="specgit-state-note" title={note.name}>{note.name}</p>}</Top>
        <div class="specgit-panel-body">
          {onboarding.kind === "running" ? (
            <OnboardProgress phase={onboarding.phase} done={onboarding.done} total={onboarding.total} show={actions.onboard} />
          ) : state.signedIn ? (
            <ChooseRepository chooseRepository={actions.chooseRepository} onboarding={onboarding} actions={actions} />
          ) : (
            <Welcome signIn={actions.signIn} mapped={state.mapped} onboarding={onboarding} actions={actions} />
          )}
        </div>
      </div>
    );
  }
  const statusTab = tab === "status" ? mine?.contents({ state, actions }).status : null;
  return (
    <div class="specgit-panel">
      <Header state={state} actions={actions} />
      <Tabs ids={ids} tab={tab} tabs={ALL_TABS} select={model.selectTab} badges={shown} />
      <div class={`specgit-panel-body${statusTab ? " specgit-panel-body-status" : ""}`} role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`}>
        {tab === "status" && note !== null && cameIn !== null && (
          <p class="specgit-said" role="status">
            {cameInWords(cameIn)}
            <button type="button" class="specgit-button" onClick={() => actions.seeChanges(note.path)}>
              See changes
            </button>
          </p>
        )}
        {tab === "comments" ? <CommentsTab env={comments.env} path={note?.path ?? null} file={state.file?.kind} /> : statusTab}
      </div>
    </div>
  );
}

const TONES: Record<NoteWord, "quiet" | "live" | "working" | "warn"> = {
  Local: "quiet",
  "Connecting…": "working",
  Live: "live",
  "Reconnecting…": "working",
  "Not live": "warn",
};

function NotLiveWhy({ status, actions }: { status: PanelState["status"]; actions: PanelActions }) {
  switch (status?.why) {
    case "read-only":
      return <p class="specgit-hint" data-testid="not-live-why">{NOT_LIVE.readOnly(actions.repo?.() ?? "this repository")}</p>;
    case "revoked":
      return (
        <>
          <p class="specgit-hint" data-testid="not-live-why">{NOT_LIVE.revoked}</p>
          <button type="button" class="specgit-button is-primary" onClick={actions.signIn}>{NOT_LIVE.signIn}</button>
        </>
      );
    case "unreachable":
      return (
        <>
          <p class="specgit-hint" data-testid="not-live-why">{NOT_LIVE.unreachable}</p>
          <Retrying at={status?.retryAt ?? null} tryNow={actions.tryNow} />
        </>
      );
    case "deleted":
      return <p class="specgit-hint" data-testid="not-live-why">{NOT_LIVE.deleted}</p>;
    default:
      return <p class="specgit-hint">Disconnect, then Connect Live to try again.</p>;
  }
}

function Retrying({ at, tryNow }: { at: number | null; tryNow?: (() => void) | undefined }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (at === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [at]);
  const seconds = at === null ? 0 : Math.ceil((at - now) / 1_000);
  return (
    <p class="specgit-hint specgit-retrying" data-testid="not-live-retry" role="status">
      <span>{seconds > 0 ? NOT_LIVE.retryIn(seconds) : NOT_LIVE.trying}</span>
      {tryNow && (
        <button type="button" class="specgit-retry-now" onClick={tryNow}>
          {NOT_LIVE.tryNow}
        </button>
      )}
    </p>
  );
}

function Header({ state, actions }: { state: PanelState; actions: PanelActions }) {
  const { note, status } = state;
  const word = status ? wordFor(status) : "Local";
  return (
    <Top
      repo={state.repo}
      tools={<StayControl on={state.stay} set={actions.setStayConnected} />}
      bar={
        note && (
          <p class="specgit-state" role="status">
            <span class={`specgit-dot is-${TONES[word]}`} aria-hidden="true" />
            <span class="specgit-state-word">{word}</span>
          </p>
        )
      }
    >
      {note ? noteLines(state, actions) : state.file ? <FileBlock file={state.file} actions={actions} /> : <NoNote elsewhere={state.elsewhere} repo={state.repo} folder={state.folder} />}
    </Top>
  );
}

function FileBlock({ file, actions }: { file: NonNullable<PanelState["file"]>; actions: PanelActions }) {
  return (
    <>
      <p class="specgit-state-note" title={file.name}>
        {file.name}
      </p>
      <p class="specgit-hint" data-testid="file-words">{FILE_WORDS[file.kind]}</p>
      {file.kind !== "other" && <Links path={file.path} actions={actions} />}
    </>
  );
}

function Links({ path, actions }: { path: string; actions: PanelActions }) {
  return (
    <div class="specgit-links">
      <button type="button" class="specgit-button" onClick={() => actions.openInSpecgit(path)}>
        <Icon name="external-link" />
        Open in specgit
      </button>
      <button type="button" class="specgit-button" onClick={() => actions.copyLink(path)}>
        <Icon name="copy" />
        Copy link
      </button>
    </div>
  );
}

function NoNote({ elsewhere, repo, folder }: { elsewhere: PanelState["elsewhere"]; repo: string; folder: string }) {
  return (
    <EmptyState icon={elsewhere ? "folder-x" : "file-text"} compact>
      {elsewhere ? outsideFolderWords(folder, repo, elsewhere) : "Open a note to connect it."}
    </EmptyState>
  );
}

function noteLines(state: PanelState, actions: PanelActions): ComponentChildren {
  const phase = phaseOf(state.status);
  const readOnly = phase === "live" && state.status?.readOnly === true;
  if (!isNotLive(phase) && !readOnly) return null;
  return (
    <>
      {isNotLive(phase) && <NotLiveWhy status={state.status} actions={actions} />}
      {readOnly && <p class="specgit-hint">You can read this note live but not change it.</p>}
    </>
  );
}

function Top({ bar, repo, tools, children }: { bar?: ComponentChildren; repo?: string; tools?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="specgit-top">
      <div class="specgit-brandbar">
        <span class="specgit-brand">
          <Mark />
          <Wordmark />
        </span>
        {bar}
      </div>
      {repo && (
        <p class="specgit-repo" title={repo} data-testid="panel-repo">
          {repo}
        </p>
      )}
      {tools}
      {children && <div class="specgit-header">{children}</div>}
    </div>
  );
}

function Tabs({ ids, tab, tabs, select, badges }: { ids: string; tab: TabId; tabs: ReadonlyArray<{ id: TabId; label: string; icon: string }>; select: (tab: TabId) => void; badges: TabBadges }) {
  const move = (event: KeyboardEvent): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const next = tabs[(tabs.findIndex((candidate) => candidate.id === tab) + step + tabs.length) % tabs.length];
    if (!next) return;
    select(next.id);
    const tablist = event.currentTarget as HTMLElement;
    tablist.win.requestAnimationFrame(() => tablist.doc.getElementById(`${ids}-tab-${next.id}`)?.focus());
  };
  return (
    <div class="specgit-tabs is-two" role="tablist" aria-label="specgit panels" onKeyDown={move}>
      {tabs.map(({ id, label, icon }) => (
        <TabButton key={id} ids={ids} id={id} icon={icon} label={label} selected={tab === id} aria={labelFor(id, label, badges)} tip={tipOf(id)} select={select}>
          <Badge id={id} badges={badges} />
        </TabButton>
      ))}
    </div>
  );
}

function tipOf(id: TabId): { name: string; line: string } {
  return id === "status" ? STATUS_CONTROL_TIPS.statusTab : STATUS_CONTROL_TIPS.commentsTab;
}

function TabButton({ ids, id, icon, label, selected, aria, tip, select, children }: { ids: string; id: TabId; icon: string; label: string; selected: boolean; aria: string; tip: { name: string; line: string } | undefined; select: (tab: TabId) => void; children: ComponentChildren }) {
  const [open, setOpen] = useTipOpen();
  const touch = useTipTouch(setOpen);
  const button = useRef<HTMLButtonElement>(null);
  const tipId = `${ids}-tip-${id}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        role="tab"
        id={`${ids}-tab-${id}`}
        aria-selected={selected}
        aria-controls={`${ids}-panel`}
        aria-label={aria}
        aria-describedby={open && tip ? tipId : undefined}
        tabIndex={selected ? 0 : -1}
        class="specgit-tab"
        {...(tip
          ? {
              onPointerEnter: (event: PointerEvent) => event.pointerType !== "touch" && setOpen(true),
              onPointerLeave: (event: PointerEvent) => event.pointerType !== "touch" && setOpen(false),
              onFocus: (event: FocusEvent) => (event.currentTarget as HTMLElement).matches(":focus-visible") && setOpen(true),
              onBlur: () => setOpen(false),
              ...touch.handlers,
            }
          : {})}
        onClick={tip ? touch.guardClick(() => (setOpen(false), select(id))) : () => select(id)}
      >
        <span class="specgit-tab-icon">
          <Icon name={icon} />
        </span>
        <span class="specgit-tab-label">{label}</span>
        {children}
      </button>
      {tip && open && button.current && (
        <Tip id={tipId} anchor={button.current}>
          <b>{tip.name}</b>
          <span>{tip.line}</span>
        </Tip>
      )}
    </>
  );
}

function labelFor(id: TabId, label: string, badges: TabBadges): string {
  return id === "comments" && badges.comments.open > 0 ? `${label}, ${badges.comments.open} open` : label;
}

function Badge({ id, badges }: { id: TabId; badges: TabBadges }) {
  return id === "comments" && badges.comments.open > 0 ? <span class="specgit-badge is-info">{badges.comments.open}</span> : null;
}
