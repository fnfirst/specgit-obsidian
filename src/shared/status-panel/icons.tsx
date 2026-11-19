const base = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const DotsIcon = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <circle cx="3" cy="8" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="13" cy="8" r="1.4" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...base} strokeWidth={2}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...base}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export const ChevronIcon = () => (
  <svg {...base}>
    <path d="M6 3.5l4.5 4.5L6 12.5" />
  </svg>
);
