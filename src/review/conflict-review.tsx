import { useState } from "preact/hooks";
import { isValidBaseYaml } from "../changes/same-base";
import { isValidCanvas } from "../disk/structured-merge";
import { wordDiff } from "../disk/word-diff";
import { type Choice, type Conflict, chosen, isConflict, type Region, resolved, type Shown } from "../disk/regions";
import type { ReviewFormat, ReviewSide, Settle } from "../editor/services";
import { MERGE, type MergeKeep } from "../shared/review-flow/merge-copy";
import { ReviewShell, ShownList, Side, Unchanged } from "./parts";
import { INVALID_BASE_YAML, INVALID_CANVAS_JSON, MERGED_REVIEW } from "./words";

export type Other = ReviewSide;
export type ReviewNoun = "note" | "board" | "file";

export interface SideWords {
  theirs: string;
  keeps: string;
  mine: string;
  mineEmpty: string;
  side: string;
  sideEmpty: string;
  unknown: string;
  moved: string;
}

const liveWords = (noun: ReviewNoun): SideWords => ({
  theirs: `the live ${noun}`,
  keeps: "theirs",
  mine: `In your ${noun}`,
  mineEmpty: `Not in your ${noun}`,
  side: `In the live ${noun}`,
  sideEmpty: `Not in the live ${noun}`,
  unknown: `Your ${noun} and the live ${noun} differ here. Choose which to keep in each place.`,
  moved: `The live ${noun} changed while you were choosing. Choose again.`,
});

const githubWords = (noun: ReviewNoun): SideWords => ({
  theirs: "GitHub",
  keeps: "GitHub's",
  mine: "In your vault",
  mineEmpty: "Not in your vault",
  side: "On GitHub",
  sideEmpty: "Not on GitHub",
  unknown: `Your ${noun} and GitHub's version differ here. Choose which to keep in each place.`,
  moved: "GitHub's version changed while you were choosing. Choose again.",
});

const teammateWords = (name: string, kind: "draft" | "review", noun: ReviewNoun): SideWords => ({
  theirs: name,
  keeps: `${name}'s`,
  mine: "In your vault",
  mineEmpty: "Not in your vault",
  side: `In ${name}'s ${kind}`,
  sideEmpty: `Not in ${name}'s ${kind}`,
  unknown: `Your ${noun} and ${name}'s ${kind} differ here. Choose which to keep in each place.`,
  moved: `${name}'s ${kind} changed while you were choosing. Choose again.`,
});

export const wordsOf = (other: Other, noun: ReviewNoun = "note"): SideWords =>
  typeof other === "object" ? teammateWords(other.teammate, other.submitted ? "review" : "draft", noun) : other === "github" ? githubWords(noun) : liveWords(noun);

interface FormatRule {
  noun: ReviewNoun;
  sides: ReadonlyArray<"mine" | "theirs" | "both">;
  allowEdit: boolean;
  validate: (text: string) => string | null;
}

const FORMAT_RULES: Record<ReviewFormat, FormatRule> = {
  note: {
    noun: "note",
    sides: ["mine", "theirs", "both"],
    allowEdit: true,
    validate: () => null,
  },
  base: {
    noun: "file",
    sides: ["mine", "theirs"],
    allowEdit: true,
    validate: (text) => (isValidBaseYaml(text) ? null : INVALID_BASE_YAML),
  },
  canvas: {
    noun: "board",
    sides: ["mine", "theirs"],
    allowEdit: false,
    validate: (text) => (isValidCanvas(text) ? null : INVALID_CANVAS_JSON),
  },
};

const kindOf = (side: "mine" | "theirs" | "both"): MergeKeep => (side === "mine" ? "ours" : side);

const markOf = (choice: Choice, keeps: string): string => (typeof choice === "object" ? MERGE.edited : MERGE.keep(kindOf(choice), keeps));

const MERGED_WORDS = { before: MERGED_REVIEW.before, after: MERGED_REVIEW.after, beforeEmpty: "Nothing here before", afterEmpty: "Nothing here now" };

export interface ConflictReviewProps {
  regions: Region[];
  merged?: Shown[];
  fromBase: boolean;
  format?: ReviewFormat;
  other?: Other;
  settle?: () => Settle;
  apply: (text: string) => void;
  cancel: () => void;
}

export function ConflictReview(props: ConflictReviewProps) {
  const other = props.other ?? "live";
  const rule = FORMAT_RULES[props.format ?? "note"];
  const words = wordsOf(other, rule.noun);
  const [regions, setRegions] = useState(props.regions);
  const [choices, setChoices] = useState<Array<Choice | undefined>>([]);
  const [told, setTold] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const conflicts = regions.filter(isConflict);
  const total = conflicts.length;
  const made = choices.filter((choice) => choice !== undefined).length;
  const text = resolved(regions, choices);

  const pick = (index: number, choice: Choice): void => {
    setError(null);
    setChoices((before) => {
      const next = [...before];
      next[index] = choice;
      return next;
    });
  };
  const pickAll = (side: "ours" | "theirs"): void => {
    setError(null);
    setChoices(Array.from({ length: total }, () => (side === "ours" ? "mine" : "theirs")));
  };

  const apply = (): void => {
    if (text === null) return;
    setError(null);
    const problem = rule.validate(text);
    if (problem !== null) return setError(problem);
    const verdict = props.settle ? props.settle() : null;
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
    return <Card key={at} number={index + 1} total={total} conflict={region} choice={choices[index]} pick={(choice) => pick(index, choice)} words={words} rule={rule} />;
  });
  const intro = total > 0 ? (props.fromBase ? MERGE.intro(words.theirs, rule.noun, total) : words.unknown) : props.merged ? MERGED_REVIEW.intro : null;
  const clean = total === 0 && !props.merged ? { title: MERGE.clean.title, body: MERGE.clean.body(words.theirs, rule.noun) } : null;
  const extraProgress =
    text !== null ? (
      <button type="button" class="specgit-button is-link" aria-expanded={preview} onClick={() => setPreview(!preview)}>
        {preview ? MERGE.hideResult : MERGE.previewResult}
      </button>
    ) : null;
  const afterBody = text !== null && ((total === 0 && !props.merged) || preview) ? <pre class="specgit-text specgit-review-result">{text}</pre> : null;

  return (
    <ReviewShell
      intro={intro}
      told={told}
      clean={clean}
      total={total}
      made={made}
      complete={text !== null}
      keeps={words.keeps}
      onPickAll={pickAll}
      extraProgress={extraProgress}
      error={error}
      onCancel={props.cancel}
      onApply={apply}
      afterBody={afterBody}
    >
      {total === 0 && props.merged ? <ShownList shown={props.merged} words={MERGED_WORDS} /> : body}
    </ReviewShell>
  );
}

interface CardProps {
  number: number;
  total: number;
  conflict: Conflict;
  choice: Choice | undefined;
  pick: (choice: Choice) => void;
  words: SideWords;
  rule: FormatRule;
}

function Card({ number, total, conflict, choice, pick, words, rule }: CardProps) {
  const marks = wordDiff(conflict.mine, conflict.theirs);
  const edited = typeof choice === "object";
  const keeps = (side: "mine" | "theirs"): boolean => choice === side || choice === "both";
  return (
    <section class={`specgit-card${choice !== undefined ? " is-resolved" : ""}`} aria-label={MERGE.conflictOf(number, total)}>
      <header class="specgit-card-head">
        <span>{MERGE.conflictOf(number, total)}</span>
        {choice !== undefined && <span class="specgit-card-mark">{markOf(choice, words.keeps)}</span>}
      </header>
      <div class="specgit-card-sides">
        <Side label={words.mine} text={conflict.mine} empty={words.mineEmpty} tone={keeps("mine") ? "kept" : undefined} words={marks?.mine} />
        <Side label={words.side} text={conflict.theirs} empty={words.sideEmpty} tone={keeps("theirs") ? "kept" : undefined} words={marks?.theirs} />
      </div>
      <div class="specgit-card-actions" role="group" aria-label={`Choose for conflict ${number}`}>
        {rule.sides.map((side) => (
          <button key={side} type="button" class="specgit-button" aria-pressed={choice === side} onClick={() => pick(side)}>
            {MERGE.keep(kindOf(side), words.keeps)}
          </button>
        ))}
        {rule.allowEdit && (
          <button type="button" class="specgit-button" aria-pressed={edited} onClick={() => pick(edited ? choice : { edited: chosen(conflict, choice ?? "mine") })}>
            {MERGE.edit}
          </button>
        )}
      </div>
      {rule.allowEdit && edited && (
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
