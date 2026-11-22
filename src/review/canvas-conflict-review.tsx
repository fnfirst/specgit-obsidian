import { useState } from "preact/hooks";
import { serializeValidCanvas } from "../disk/structured-merge";
import { wordDiff } from "../disk/word-diff";
import { canvasCleanSummary, canvasConflictGroups, chooseAllCanvasConflicts } from "../shared/canvas/canvas-conflicts";
import { resolveCanvasMerge } from "../shared/canvas/canvas-merge";
import type { CanvasConflictChoice, CanvasMergeResult } from "../shared/canvas/canvas-types";
import { MERGE } from "../shared/review-flow/merge-copy";
import { type Other, wordsOf } from "./conflict-review";
import { ReviewShell, Side } from "./parts";
import { INVALID_CANVAS_JSON, MERGED_BOARD } from "./words";

export interface CanvasConflictReviewProps {
  result: CanvasMergeResult;
  fromBase: boolean;
  other?: Other;
  apply: (text: string) => void;
  cancel: () => void;
}

export function CanvasConflictReview(props: CanvasConflictReviewProps) {
  const words = wordsOf(props.other ?? "live", "board");
  const [choices, setChoices] = useState<Record<string, CanvasConflictChoice>>({});
  const [error, setError] = useState<string | null>(null);
  const items = canvasConflictGroups(props.result).flatMap((group) =>
    group.conflicts.map((row) => ({ kind: group.kind, title: group.title, row })),
  );
  const total = items.length;
  const made = props.result.conflicts.filter((conflict) => Object.prototype.hasOwnProperty.call(choices, conflict.key)).length;
  const complete = made === total;

  const pick = (key: string, choice: CanvasConflictChoice): void => {
    setError(null);
    setChoices((before) => ({ ...before, [key]: choice }));
  };

  const pickAll = (side: CanvasConflictChoice): void => {
    setError(null);
    setChoices(chooseAllCanvasConflicts(props.result, side));
  };

  const apply = (): void => {
    if (!complete) return;
    setError(null);
    const text = serializeValidCanvas(resolveCanvasMerge(props.result, choices));
    if (text === null) return setError(INVALID_CANVAS_JSON);
    props.apply(text);
  };

  const intro = total > 0 ? (props.fromBase ? MERGE.intro(words.theirs, "board", total) : words.unknown) : null;
  const clean = total === 0 ? { title: MERGE.clean.title, body: MERGE.clean.body(words.theirs, "board") } : null;
  const summary = total === 0 ? canvasCleanSummary(props.result) : [];

  return (
    <ReviewShell
      intro={intro}
      clean={clean}
      total={total}
      made={made}
      complete={complete}
      keeps={words.keeps}
      onPickAll={pickAll}
      error={error}
      onCancel={props.cancel}
      onApply={apply}
    >
      {total === 0 ? (
        <section class="specgit-card">
          <pre class="specgit-text">{summary.length > 0 ? summary.join("\n") : MERGED_BOARD.empty}</pre>
        </section>
      ) : (
        items.map(({ kind, title, row }, at) => {
          const number = at + 1;
          const key = row.conflict.key;
          const choice = Object.prototype.hasOwnProperty.call(choices, key) ? choices[key] : undefined;
          const oursText = row.ours.empty ? "" : row.ours.text;
          const theirsText = row.theirs.empty ? "" : row.theirs.text;
          const marks = oursText !== "" && theirsText !== "" ? wordDiff(oursText, theirsText) : null;
          return (
            <section
              key={key}
              class={`specgit-card${choice !== undefined ? " is-resolved" : ""}`}
              aria-label={MERGE.conflictOf(number, total)}
            >
              <header class="specgit-card-head">
                <span>{`${kind}: ${title} · ${row.label}`}</span>
                {choice !== undefined && <span class="specgit-card-mark">{MERGE.keep(choice, words.keeps)}</span>}
              </header>
              <p class="specgit-review-intro">{row.reason}</p>
              <div class="specgit-card-sides">
                <Side
                  label={words.mine}
                  text={oursText}
                  empty={row.ours.empty ? row.ours.text : words.mineEmpty}
                  tone={choice === "ours" ? "kept" : undefined}
                  words={marks?.mine}
                />
                <Side
                  label={words.side}
                  text={theirsText}
                  empty={row.theirs.empty ? row.theirs.text : words.sideEmpty}
                  tone={choice === "theirs" ? "kept" : undefined}
                  words={marks?.theirs}
                />
              </div>
              <div class="specgit-card-actions" role="group" aria-label={`Choose for conflict ${number}`}>
                <button type="button" class="specgit-button" aria-pressed={choice === "ours"} onClick={() => pick(key, "ours")}>
                  {MERGE.keep("ours", words.keeps)}
                </button>
                <button type="button" class="specgit-button" aria-pressed={choice === "theirs"} onClick={() => pick(key, "theirs")}>
                  {MERGE.keep("theirs", words.keeps)}
                </button>
              </div>
            </section>
          );
        })
      )}
    </ReviewShell>
  );
}
