import type { ChangeLine } from "./catch-up-protocol";

const places = (n: number) => (n === 1 ? "1 place" : `${n} places`);

export const CATCH_UP = {
  title: (base: string) => `Catch up with ${base}`,
  done: (base: string) => `Caught up with ${base}`,
  behind: (kind: "document" | "board") => `The published version has changed since your review began. This ${kind === "board" ? "board" : "document"} is behind it.`,
  keeps: "Catching up adds those changes to your review. Everything in your review stays.",
  conflicts: (n: number) => `You and the published version both changed ${places(n)}. You'll choose what to keep.`,
  button: (base: string) => `Catch up with ${base}`,
  busy: "Catching up…",
  choose: "Choose what to keep…",
  inSpecgit: "Resolve in specgit",
  checking: "Checking the published version…",
  moreLines: (n: number) => `and ${n} more`,
  line: (line: ChangeLine): string => {
    switch (line.kind) {
      case "added":
        return `Added: ${line.text}`;
      case "removed":
        return `Removed: ${line.text}`;
      case "moved":
        return `Moved: ${line.text}`;
      case "resized":
        return `Resized: ${line.text}`;
      case "changed":
        return line.before === undefined ? `Changed: ${line.text}` : `Now: ${line.text}`;
    }
  },
  was: (before: string) => `It said: ${before}`,
  stays: "Everything in your review is still here.",
  toastDone: (summary: string, base: string) => ({ title: `Caught up with ${base}`, description: `${summary} Your edits are all still here.` }),
  toastMoved: { title: "The published version changed again", description: "Here is what it changed now. Look it over, then catch up." },
  confirm: {
    title: "Catch up this review?",
    description:
      "The published changes are added to your review. Reviewers may be asked to look again. Nothing in your review is removed.",
    confirmLabel: "Catch up",
  },
  failed: "Couldn't catch up with the published version",
  failedBody: "Please try again in a moment.",
} as const;
