import type { ComponentChildren } from "preact";
import type { Shown } from "../disk/regions";
import type { WordPart } from "../disk/word-diff";
import { MERGE } from "../shared/review-flow/merge-copy";

export interface ReviewShellProps {
  intro?: string | null;
  told?: string | null;
  clean?: { title: string; body: string } | null;
  total: number;
  made: number;
  complete: boolean;
  keeps: string;
  onPickAll?: (side: "ours" | "theirs") => void;
  extraProgress?: ComponentChildren;
  error: string | null;
  onCancel: () => void;
  onApply: () => void;
  children: ComponentChildren;
  afterBody?: ComponentChildren;
}

export function ReviewShell(props: ReviewShellProps) {
  return (
    <div class="specgit-review">
      {props.intro && <p class="specgit-review-intro">{props.intro}</p>}
      {props.told && (
        <p class="specgit-review-told" role="status">
          {props.told}
        </p>
      )}
      {props.clean && (
        <p class="specgit-review-clean">
          <strong>{props.clean.title}.</strong> {props.clean.body}
        </p>
      )}
      <div class="specgit-review-body">{props.children}</div>
      {props.afterBody}
      <footer class="specgit-review-footer">
        {props.total > 0 && (
          <div class="specgit-review-progress">
            <span class={`specgit-review-count${props.complete ? " is-done" : ""}`} role="status">
              {MERGE.resolved(props.made, props.total)}
            </span>
            {props.total > 1 && props.onPickAll && (
              <>
                <button type="button" class="specgit-button" onClick={() => props.onPickAll!("ours")}>
                  {MERGE.keepAll("ours", props.keeps)}
                </button>
                <button type="button" class="specgit-button" onClick={() => props.onPickAll!("theirs")}>
                  {MERGE.keepAll("theirs", props.keeps)}
                </button>
              </>
            )}
            {props.extraProgress}
          </div>
        )}
        {props.error !== null && (
          <p class="specgit-review-error" role="alert">
            {props.error}
          </p>
        )}
        <div class="specgit-review-actions">
          <button type="button" class="specgit-button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" class="specgit-button is-primary" disabled={!props.complete} onClick={props.onApply}>
            Apply
          </button>
        </div>
      </footer>
    </div>
  );
}

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

export function Side({ label, text, empty, tone, words }: { label: string; text: string; empty: string; tone?: "kept" | "removed" | "added";  words?: WordPart[] }) {
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
