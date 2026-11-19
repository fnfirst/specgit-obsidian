import type { Shown } from "../disk/regions";
import type { WordPart } from "../disk/word-diff";
import { MERGE } from "../shared/review-flow/merge-copy";

export function Unchanged({ text }: { text: string }) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  if (lines.length === 1) return <p class="specgit-unchanged-line">{lines[0]}</p>;
  return (
    <details class="specgit-unchanged">
      <summary>{MERGE.unchanged(lines.length, "line")}</summary>
      <pre class="specgit-text">{text}</pre>
    </details>
  );
}

export function Side({ label, text, empty, tone, words }: { label: string; text: string; empty: string; tone?: "kept" | "removed" | "added";   words?: WordPart[] }) {
  return (
    <div class={`specgit-side${tone ? ` is-${tone}` : ""}`}>
      <p class="specgit-side-label">{label}</p>
      {text === "" ? (
        <p class="specgit-side-empty">{empty}</p>
      ) : (
        <pre class="specgit-text">
          {words
            ? words.map((part, at) =>
                part.changed ? (
                  <mark key={at} class="specgit-word-diff">
                    {part.text}
                  </mark>
                ) : (
                  part.text
                ),
              )
            : text}
        </pre>
      )}
    </div>
  );
}

export interface ShownWords {
  before: string;
  after: string;
  beforeEmpty: string;
  afterEmpty: string;
}

export function ShownList({ shown, words }: { shown: readonly Shown[]; words: ShownWords }) {
  return (
    <>
      {shown.map((part, at) =>
        part.kind === "heading" ? (
          <h4 key={at} class="specgit-shown-heading">
            {part.text}
          </h4>
        ) : part.kind === "same" ? (
          <Unchanged key={at} text={part.text} />
        ) : (
          <section key={at} class="specgit-card">
            <div class="specgit-card-sides">
              <Side label={words.before} text={part.before} empty={words.beforeEmpty} tone="removed" />
              <Side label={words.after} text={part.after} empty={words.afterEmpty} tone="added" />
            </div>
          </section>
        ),
      )}
    </>
  );
}
