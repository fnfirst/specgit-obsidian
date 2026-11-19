import { useState } from "preact/hooks";
import { wordDiff } from "../disk/word-diff";
import { type Choice, type Conflict, chosen, isConflict, type Region, resolved, type Shown } from "../disk/regions";
import type { ReviewSide, Settle } from "../editor/services";
import { MERGE, type MergeKeep } from "../shared/review-flow/merge-copy";
import { ShownList, Side, Unchanged } from "./parts";
import { MERGED_REVIEW } from "./words";

export type Other = ReviewSide;

interface SideWords {
  theirs: string;
  keeps: string;
  mine: string;
  mineEmpty: string;
  side: string;
  sideEmpty: string;
  unknown: string;
  moved: string;
}

const WORDS: Record<"live" | "github", SideWords> = {
  live: {
    theirs: "the live note",
    keeps: "theirs",
    mine: "In your note",
    mineEmpty: "Not in your note",
    side: "In the live note",
    sideEmpty: "Not in the live note",
    unknown: "Your note and the live note differ here. Choose which to keep in each place.",
    moved: "The live note changed while you were choosing. Choose again.",
  },
  github: {
    theirs: "GitHub",
    keeps: "GitHub's",
    mine: "In your vault",
    mineEmpty: "Not in your vault",
    side: "On GitHub",
    sideEmpty: "Not on GitHub",
    unknown: "Your note and GitHub's version differ here. Choose which to keep in each place.",
    moved: "GitHub's version changed while you were choosing. Choose again.",
  },
};

const teammateWords = (name: string, noun: "draft" | "review"): SideWords => ({
  theirs: name,
  keeps: `${name}'s`,
  mine: "In your vault",
  mineEmpty: "Not in your vault",
  side: `In ${name}'s ${noun}`,
  sideEmpty: `Not in ${name}'s ${noun}`,
  unknown: `Your note and ${name}'s ${noun} differ here. Choose which to keep in each place.`,
  moved: `${name}'s ${noun} changed while you were choosing. Choose again.`,
});

const wordsOf = (other: Other): SideWords => (typeof other === "object" ? teammateWords(other.teammate, other.submitted ? "review" : "draft") : WORDS[other]);

const kindOf = (side: "mine" | "theirs" | "both"): MergeKeep => (side === "mine" ? "ours" : side);

const markOf = (choice: Choice, other: Other): string => (typeof choice === "object" ? MERGE.edited : MERGE.keep(kindOf(choice), wordsOf(other).keeps));

const MERGED_WORDS = { before: MERGED_REVIEW.before, after: MERGED_REVIEW.after, beforeEmpty: "Nothing here before", afterEmpty: "Nothing here now" };

export interface ConflictReviewProps {
  regions: Region[];

  merged?: Shown[];

  fromBase: boolean;

  other?: Other;

  settle: () => Settle;

  apply: (text: string) => void;
  cancel: () => void;
}

export function ConflictReview(props: ConflictReviewProps) {
  const other = props.other ?? "live";
  const words = wordsOf(other);
  const [regions, setRegions] = useState(props.regions);
  const [choices, setChoices] = useState<Array<Choice | undefined>>([]);
  const [told, setTold] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const conflicts = regions.filter(isConflict);
  const total = conflicts.length;
  const made = choices.filter((choice) => choice !== undefined).length;
  const text = resolved(regions, choices);

  const pick = (index: number, choice: Choice): void =>
    setChoices((before) => {
      const next = [...before];
      next[index] = choice;
      return next;
    });
  const pickAll = (side: "mine" | "theirs"): void => setChoices(Array.from({ length: total }, () => side));

  const apply = (): void => {
    if (text === null) return;
    setError(null);
    const verdict = props.settle();
    if (verdict === null) return props.apply(text);
    if ("error" in verdict) return setError(verdict.error);

    setRegions(verdict.regions);
    setChoices([]);
    setPreview(false);
    setTold(words.moved);
  };

  const body = regions.map((region, at) => {
    if (!isConflict(region)) return <Unchanged key={at} text={region.text} />;

    const index = conflicts.indexOf(region);
    return <Card key={at} number={index + 1} total={total} conflict={region} choice={choices[index]} pick={(choice) => pick(index, choice)} other={other} />;
  });
  const intro = props.fromBase ? MERGE.intro(words.theirs, "note", total) : words.unknown;

  return (
    <div class="specgit-review">
      {total > 0 && <p class="specgit-review-intro">{intro}</p>}
      {told !== null && (
        <p class="specgit-review-told" role="status">
          {told}
        </p>
      )}
      {total === 0 && props.merged && <p class="specgit-review-intro">{MERGED_REVIEW.intro}</p>}
      {total === 0 && !props.merged && (
        <p class="specgit-review-clean">
          <strong>{MERGE.clean.title}.</strong> {MERGE.clean.body(words.theirs, "note")}
        </p>
      )}
      <div class="specgit-review-body">
        {total === 0 && props.merged ? <ShownList shown={props.merged} words={MERGED_WORDS} /> : body}
      </div>
      {text !== null && ((total === 0 && !props.merged) || preview) && <pre class="specgit-text specgit-review-result">{text}</pre>}
      <footer class="specgit-review-footer">
        {total > 0 && (
          <div class="specgit-review-progress">
            <span class={`specgit-review-count${text !== null ? " is-done" : ""}`} role="status">
              {MERGE.resolved(made, total)}
            </span>
            {total > 1 && (
              <>
                <button type="button" class="specgit-button" onClick={() => pickAll("mine")}>
                  {MERGE.keepAll("ours", words.keeps)}
                </button>
                <button type="button" class="specgit-button" onClick={() => pickAll("theirs")}>
                  {MERGE.keepAll("theirs", words.keeps)}
                </button>
              </>
            )}
            {text !== null && (
              <button type="button" class="specgit-button is-link" aria-expanded={preview} onClick={() => setPreview(!preview)}>
                {preview ? MERGE.hideResult : MERGE.previewResult}
              </button>
            )}
          </div>
        )}
        {error !== null && (
          <p class="specgit-review-error" role="alert">
            {error}
          </p>
        )}
        <div class="specgit-review-actions">
          <button type="button" class="specgit-button" onClick={props.cancel}>
            Cancel
          </button>
          <button type="button" class="specgit-button is-primary" disabled={text === null} onClick={apply}>
            Apply
          </button>
        </div>
      </footer>
    </div>
  );
}

interface CardProps {
  number: number;
  total: number;
  conflict: Conflict;
  choice: Choice | undefined;
  pick: (choice: Choice) => void;
  other: Other;
}

function Card({ number, total, conflict, choice, pick, other }: CardProps) {
  const words = wordsOf(other);

  const marks = wordDiff(conflict.mine, conflict.theirs);
  const edited = typeof choice === "object";
  const keeps = (side: "mine" | "theirs"): boolean => choice === side || choice === "both";
  return (
    <section class={`specgit-card${choice !== undefined ? " is-resolved" : ""}`} aria-label={MERGE.conflictOf(number, total)}>
      <header class="specgit-card-head">
        <span>{MERGE.conflictOf(number, total)}</span>
        {choice !== undefined && <span class="specgit-card-mark">{markOf(choice, other)}</span>}
      </header>
      <div class="specgit-card-sides">
        <Side label={words.mine} text={conflict.mine} empty={words.mineEmpty} tone={keeps("mine") ? "kept" : undefined} words={marks?.mine} />
        <Side label={words.side} text={conflict.theirs} empty={words.sideEmpty} tone={keeps("theirs") ? "kept" : undefined} words={marks?.theirs} />
      </div>
      <div class="specgit-card-actions" role="group" aria-label={`Choose for conflict ${number}`}>
        {(["mine", "theirs", "both"] as const).map((side) => (
          <button key={side} type="button" class="specgit-button" aria-pressed={choice === side} onClick={() => pick(side)}>
            {MERGE.keep(kindOf(side), words.keeps)}
          </button>
        ))}
        { }
        <button type="button" class="specgit-button" aria-pressed={edited} onClick={() => pick(edited ? choice : { edited: chosen(conflict, choice ?? "mine") })}>
          {MERGE.edit}
        </button>
      </div>
      {edited && (
        <textarea
          class="specgit-card-edit"
          aria-label={MERGE.editAria}
          value={choice.edited}
          onInput={(event) => pick({ edited: event.currentTarget.value })}
        />
      )}
    </section>
  );
}
