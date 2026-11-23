import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { StatusPillState } from "../review-flow";
import { positionCard } from "./place-card";

const HOVER_MS = 500;
const CARD_WIDTH = 264;

export type TipPicture = "ladder" | "join" | "group" | "changes" | "held";

export interface TipContent {
  picture?: TipPicture;
  lit?: StatusPillState | null;
  name: string;
  line: string;
  reason?: string;
  link?: { label: string; href: string };
}

interface OpenTip {
  key: string;
  anchor: HTMLElement;
  content: TipContent;
  pinned: boolean;
}

interface PointerLike {
  currentTarget: HTMLElement;
  pointerType?: string;
}

export interface TipHandlers {
  onPointerEnter: (event: PointerLike) => void;
  onPointerLeave: (event: PointerLike) => void;
  onPointerDown: (event: PointerLike) => void;
  onPointerUp: (event: PointerLike) => void;
  onPointerCancel: () => void;
  onFocus: (event: { currentTarget: HTMLElement }) => void;
  onBlur: () => void;
  "data-sp-tip": string;
}

export interface Tips {
  open: OpenTip | null;
  id: string;
  bind: (key: string, content: TipContent) => TipHandlers;
  toggle: (anchor: HTMLElement, key: string, content: TipContent) => void;
  openAt: (anchor: HTMLElement, key: string, content: TipContent) => void;
  hide: () => void;
}

export function useTips(rootRef: { current: HTMLElement | null }): Tips {
  const id = useId();
  const [open, setOpen] = useState<OpenTip | null>(null);
  const timer = useRef(0);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(null);
  }, []);
  useEffect(() => {
    if (open && !open.anchor.isConnected) hide();
  });
  const later = useCallback((ms: number, run: () => void) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, ms);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const place = useCallback((anchor: HTMLElement, key: string, content: TipContent, pinned: boolean): OpenTip => ({ key, anchor, content, pinned }), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    const onDown = (event: Event) => {
      const mark = (event.target as Element | null)?.closest?.("[data-sp-tip]")?.getAttribute("data-sp-tip") ?? null;
      if (open.pinned && mark !== open.key) hide();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    const onScroll = (event: Event) => {
      if (rootRef.current?.contains(event.target as Node | null)) hide();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [hide, open, rootRef]);

  const bind = useCallback(
    (key: string, content: TipContent): TipHandlers => ({
      "data-sp-tip": key,
      onPointerEnter: (event) => {
        if (event.pointerType === "touch") return;
        const anchor = event.currentTarget;
        later(HOVER_MS, () => setOpen(place(anchor, key, content, false)));
      },
      onPointerLeave: (event) => {
        if (event.pointerType === "touch") return;
        window.clearTimeout(timer.current);
        setOpen((now) => (now?.pinned ? now : null));
      },
      onPointerDown: () => undefined,
      onPointerUp: () => undefined,
      onPointerCancel: hide,
      onFocus: (event) => {
        const anchor = event.currentTarget;
        if (anchor.matches(":focus-visible")) setOpen(place(anchor, key, content, false));
      },
      onBlur: () => {
        window.clearTimeout(timer.current);
        setOpen((now) => (now?.pinned ? now : null));
      },
    }),
    [hide, later, place],
  );

  const toggle = useCallback(
    (anchor: HTMLElement, key: string, content: TipContent) => {
      window.clearTimeout(timer.current);
      setOpen((now) => (now?.pinned && now.key === key ? null : place(anchor, key, content, true)));
    },
    [place],
  );
  const openAt = useCallback((anchor: HTMLElement, key: string, content: TipContent) => setOpen(place(anchor, key, content, true)), [place]);

  return { open, id, bind, toggle, openAt, hide };
}

const LADDER: readonly StatusPillState[] = ["draft", "in-review", "ready", "published"];

function Picture({ content }: { content: TipContent }) {
  if (content.picture === "ladder") {
    return (
      <ol className="sp-ladder" aria-hidden="true">
        {LADDER.map((step) => (
          <li key={step} data-lit={content.lit === step ? "" : undefined} />
        ))}
      </ol>
    );
  }
  const common = { className: "sp-tip-art", width: 224, height: 44, viewBox: "0 0 224 44", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
  switch (content.picture) {
    case "join":
      return (
        <svg {...common}>
          <rect x="30" y="8" width="164" height="28" rx="5" />
          <path d="M44 18h60M44 26h40" />
          <path d="M120 16v12" className="sp-art-live" />
          <path d="M150 14v14" className="sp-art-accent" />
        </svg>
      );
    case "group":
      return (
        <svg {...common}>
          <path d="M70 9h70M70 22h70M70 35h70" />
          <path d="M150 7h6v30h-6M156 22h12" className="sp-art-accent" />
        </svg>
      );
    case "changes":
      return (
        <svg {...common}>
          <path d="M30 12h164M30 22h164M30 32h100" />
          <path d="M30 22h164" className="sp-art-accent" strokeWidth={6} opacity={0.35} />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="94" y="20" width="36" height="20" rx="4" />
          <path d="M101 20v-5a11 11 0 0 1 22 0v5" />
        </svg>
      );
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function safeTipHref(raw: string): string | null {
  if (typeof raw !== "string") return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^\/(?![/\\])/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.username !== "" || url.password !== "") return null;
    if (url.protocol === "https:") return url.hostname !== "" ? url.href : null;
    if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ? url.href : null;
    return null;
  } catch {
    return null;
  }
}

export function TipCard({ tip, id, root }: { tip: OpenTip; id: string; root: { current: HTMLElement | null } }) {
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (card.current) positionCard(card.current, tip.anchor, root.current);
  }, [tip, root]);
  const linkHref = tip.content.link ? safeTipHref(tip.content.link.href) : null;
  return (
    <div ref={card} id={id} role="tooltip" className="sp-tip" data-sp-tip={tip.key} style={{ left: 0, top: 0, width: CARD_WIDTH }}>
      {tip.content.picture ? <Picture content={tip.content} /> : null}
      <div className="sp-tip-name">{tip.content.name}</div>
      <p className="sp-tip-line">{tip.content.line}</p>
      {tip.content.reason ? <p className="sp-tip-reason">{tip.content.reason}</p> : null}
      {tip.content.link && linkHref !== null ? (
        <a className="sp-tip-link" href={linkHref} target="_blank" rel="noopener noreferrer">
          {tip.content.link.label}
        </a>
      ) : null}
    </div>
  );
}
