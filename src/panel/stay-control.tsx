import { useRef } from "preact/hooks";
import { Tip, useTipOpen, useTipTouch } from "../brand/tip";
import { STAY } from "../stay/words";

function StayArt() {
  return (
    <svg class="specgit-tip-art" viewBox="0 0 224 108" aria-hidden="true" focusable="false" data-testid="stay-tip-art">
      <rect x="0.5" y="0.5" width="223" height="107" rx="8" class="specgit-art-surface" />
      {[24, 44, 64].map((y) => (
        <g key={y}>
          <rect x="18" y={y} width="56" height="18" rx="5" class="specgit-art-card" />
          <rect x="24" y={y + 7} width="30" height="3" rx="1.5" class="specgit-art-ink" />
        </g>
      ))}
      <rect x="150" y="32" width="56" height="44" rx="9" class="specgit-art-accent" />
      <rect x="160" y="48" width="36" height="4" rx="2" class="specgit-art-ink" />
      <rect x="160" y="58" width="24" height="3" rx="1.5" class="specgit-art-muted" />
      <path d="M84 46H134M126 40L134 46L126 52" class="specgit-art-line" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M140 62H90M98 56L90 62L98 68" class="specgit-art-line" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function StayControl({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  const [open, setOpen] = useTipOpen();
  const touch = useTipTouch(setOpen);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div class="specgit-stay" data-testid="stay-connected" onPointerLeave={(event) => event.pointerType !== "touch" && setOpen(false)}>
      <button
        ref={button}
        type="button"
        role="switch"
        aria-checked={on}
        aria-describedby={open ? "specgit-stay-tip" : undefined}
        class="specgit-stay-switch"
        data-testid="stay-switch"
        onPointerEnter={(event) => event.pointerType !== "touch" && setOpen(true)}
        onFocus={(event) => event.currentTarget.matches(":focus-visible") && setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={touch.guardClick(() => {
          setOpen(false);
          set(!on);
        })}
        {...touch.handlers}
      >
        <span class="specgit-switch" aria-hidden="true">
          <span class="specgit-switch-knob" />
        </span>
        <span class="specgit-stay-words">
          {STAY.name}
          <span class="specgit-stay-state">{on ? STAY.on : STAY.off}</span>
        </span>
      </button>
      {open && button.current && (
        <Tip id="specgit-stay-tip" anchor={button.current} testId="stay-tip">
          <StayArt />
          <b>{STAY.name}</b>
          <span>{STAY.what}</span>
          <span class="specgit-tip-reason" data-testid="stay-tip-standing">{STAY.standing(on)}</span>
        </Tip>
      )}
    </div>
  );
}
