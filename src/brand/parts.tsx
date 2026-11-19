import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { setIcon } from "obsidian";
import { drawLogo, MARK_ICON } from "./mark";

export function Wordmark() {
  return (
    <span class="specgit-wordmark">
      spec<span class="specgit-wordmark-git">git</span>
    </span>
  );
}

export function Mark({ large = false }: { large?: boolean }) {
  return <span class={`specgit-mark${large ? " is-large" : ""}`}>{large ? <Logo /> : <Icon name={MARK_ICON} />}</span>;
}

function Logo() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) drawLogo(ref.current);
  }, []);
  return <span class="specgit-logo-box" ref={ref} />;
}

export function Icon({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) setIcon(ref.current, name);
  }, [name]);
  return <span class="specgit-icon" ref={ref} aria-hidden="true" />;
}

export function Spinner() {
  return (
    <span class="specgit-spinner" aria-hidden="true">
      <Icon name="loader" />
    </span>
  );
}

export function EmptyState({ icon, compact = false, role, children }: { icon: string; compact?: boolean; role?: "status"; children: ComponentChildren }) {
  return (
    <div class={`specgit-empty${compact ? " is-compact" : ""}`} role={role}>
      <span class="specgit-empty-icon">
        <Icon name={icon} />
      </span>
      <p class="specgit-empty-text">{children}</p>
    </div>
  );
}
