import { useRef } from "preact/hooks";
import { TAGLINE } from "../brand/mark";
import { EmptyState, Mark, Wordmark } from "../brand/parts";
import { Tip, useTipOpen, useTipTouch } from "../brand/tip";
import type { OnboardState } from "../onboard/flow";
import { CONTINUE, FREE, ONBOARD, ONBOARD_TIP, SHOW, STOPPED, underWay } from "../onboard/words";
import { NO_REPOSITORY_WORDS } from "../pick/words";

export interface OnboardActions {

  onboard: () => void;

  continueUpload: () => void;
}

function Onboarding({ state, actions }: { state: OnboardState; actions: OnboardActions }) {
  const [open, setOpen] = useTipOpen();
  const touch = useTipTouch(setOpen);
  const button = useRef<HTMLButtonElement>(null);
  if (state.kind === "stopped") {
    return (
      <>
        <EmptyState icon="upload">{STOPPED}</EmptyState>
        <button type="button" class="specgit-button is-primary" data-testid="onboard-stopped" onClick={actions.continueUpload}>
          {CONTINUE}
        </button>
      </>
    );
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        class="specgit-button"
        data-testid="onboard"
        aria-describedby={open ? "specgit-onboard-tip" : undefined}
        onPointerEnter={(event) => event.pointerType !== "touch" && setOpen(true)}
        onPointerLeave={(event) => event.pointerType !== "touch" && setOpen(false)}
        onFocus={(event) => event.currentTarget.matches(":focus-visible") && setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={touch.guardClick(() => {
          setOpen(false);
          actions.onboard();
        })}
        {...touch.handlers}
      >
        {ONBOARD}
        <span class="specgit-free">{FREE}</span>
      </button>
      {open && button.current && (
        <Tip id="specgit-onboard-tip" anchor={button.current} testId="onboard-tip">
          <span>{ONBOARD_TIP}</span>
        </Tip>
      )}
    </>
  );
}

const primaryUnless = (onboarding: OnboardState): string => (onboarding.kind === "stopped" ? "specgit-button" : "specgit-button is-primary");

export function OnboardProgress({ phase, done, total, show }: { phase: "reading" | "uploading"; done: number; total: number; show: () => void }) {
  return (
    <div class="specgit-welcome">
      <EmptyState icon="upload">{underWay(phase, done, total)}</EmptyState>
      <button type="button" class="specgit-button" data-testid="onboard-progress" onClick={show}>
        {SHOW}
      </button>
    </div>
  );
}

export function Welcome({ signIn, mapped, onboarding, actions }: { signIn: () => void; mapped: boolean; onboarding: OnboardState; actions: OnboardActions }) {
  return (
    <div class="specgit-welcome" data-testid="welcome">
      <Mark large />
      <p class="specgit-welcome-title">
        Welcome to <Wordmark />
      </p>
      <p class="specgit-welcome-line">{TAGLINE} specgit handles the Git.</p>
      <button type="button" class={primaryUnless(mapped ? { kind: "idle" } : onboarding)} onClick={signIn}>
        Sign in
      </button>
      <p class="specgit-hint">You sign in with GitHub.</p>
      {!mapped && <Onboarding state={onboarding} actions={actions} />}
    </div>
  );
}

export function ChooseRepository({ chooseRepository, onboarding, actions }: { chooseRepository: () => void; onboarding: OnboardState; actions: OnboardActions }) {
  return (
    <div class="specgit-welcome" data-testid="choose-repository">
      <EmptyState icon="folder-git-2">{NO_REPOSITORY_WORDS}</EmptyState>
      <button type="button" class={primaryUnless(onboarding)} onClick={chooseRepository}>
        Choose repository
      </button>
      <Onboarding state={onboarding} actions={actions} />
    </div>
  );
}
