import { isValidBaseYaml, sameBaseText } from "../changes/same-base";
import type { ReviewFormat, ReviewPayload, ReviewRequest, ReviewSide } from "../editor/services";
import { noteName, pathKind } from "../mapping";
import { mergeCanvas } from "../shared/canvas/canvas-merge";
import { parseCanvas } from "../shared/canvas/canvas-parse";
import { EMPTY_CANVAS_SOURCE, serializeCanvas } from "../shared/canvas/canvas-serialize";
import type { CanvasDoc, CanvasMergeResult } from "../shared/canvas/canvas-types";
import { sameCanvasText } from "../shared/review-flow/same-canvas";
import { type Budget, withoutFinalBreaks } from "./diff";
import { changesBetween, mergeRegions, twoWayRegions } from "./merge";
import { conflictsIn, type Region, resolved as resolvedRegions, theirsStanding } from "./regions";

const EMPTY_CANVAS: CanvasDoc = { nodes: [], edges: [] };

export type FileMerge =
  | { kind: "clean"; text: string; conflicts: 0; review: ReviewPayload }
  | { kind: "conflict"; conflicts: number; review: ReviewPayload };

export function reviewFormatOf(path: string): ReviewFormat {
  const kind = pathKind(path);
  return kind === "board" ? "canvas" : kind === "base" ? "base" : "note";
}

export function parseValidCanvas(text: string): CanvasDoc | null {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (body.trim() === "") return null;
  const parsed = parseCanvas(text);
  if (!parsed.ok) return null;
  if (parsed.issues.some((issue) => issue.code === "duplicate_id" || (issue.code === "invalid_value" && issue.id === undefined))) return null;
  if (parsed.canvas.nodes.some((node) => node.id === "") || parsed.canvas.edges.some((edge) => edge.id === "")) return null;
  return parsed.canvas;
}

export const isValidCanvas = (text: string): boolean => parseValidCanvas(text) !== null;

export function serializeValidCanvas(doc: CanvasDoc): string | null {
  const raw = serializeCanvas(doc);
  const text = raw.trim() === "" ? EMPTY_CANVAS_SOURCE : raw;
  return isValidCanvas(text) ? text : null;
}

function parseBaseCanvas(base: string): CanvasDoc | null {
  const body = base.startsWith("\uFEFF") ? base.slice(1) : base;
  return body.trim() === "" ? EMPTY_CANVAS : parseValidCanvas(base);
}

function cleanText(text: string, mine: string, format: ReviewFormat, fromBase: boolean, regions: Region[] = [{ kind: "same", text }]): FileMerge {
  const came = changesBetween(mine, text);
  return {
    kind: "clean",
    text,
    conflicts: 0,
    review: { kind: "text", regions, format, fromBase, ...(came ? { merged: came } : {}) },
  };
}

function wholeCanvasConflict(mine: string, theirs: string): FileMerge {
  return {
    kind: "conflict",
    conflicts: 1,
    review: { kind: "text", regions: [{ kind: "conflict", mine, theirs }], format: "canvas", fromBase: false },
  };
}

function cleanCanvasResult(base: CanvasDoc, merged: CanvasDoc, ours: CanvasDoc, theirs: CanvasDoc, text: string, fromBase: boolean): FileMerge {
  const result: CanvasMergeResult = { merged, conflicts: [], base, ours, theirs };
  return { kind: "clean", text, conflicts: 0, review: { kind: "canvas", result, fromBase } };
}

function mergeCanvasFile(base: string | null, mine: string, theirs: string): FileMerge {
  const mineDoc = parseValidCanvas(mine);
  const theirsDoc = parseValidCanvas(theirs);
  const baseOrOurs = (ours: CanvasDoc): CanvasDoc => (base !== null ? parseBaseCanvas(base) : null) ?? ours;
  if (mine === theirs || withoutFinalBreaks(mine) === withoutFinalBreaks(theirs)) {
    return mineDoc && theirsDoc
      ? cleanCanvasResult(baseOrOurs(mineDoc), theirsDoc, mineDoc, theirsDoc, theirs, base !== null)
      : cleanText(theirs, mine, "canvas", base !== null);
  }
  if (!mineDoc || !theirsDoc) return wholeCanvasConflict(mine, theirs);
  if (sameCanvasText(mine, theirs)) return cleanCanvasResult(baseOrOurs(mineDoc), theirsDoc, mineDoc, theirsDoc, theirs, base !== null);
  if (base === null) return wholeCanvasConflict(mine, theirs);
  const baseDoc = parseBaseCanvas(base);
  if (!baseDoc) return wholeCanvasConflict(mine, theirs);
  if (sameCanvasText(mine, base)) return cleanCanvasResult(baseDoc, theirsDoc, mineDoc, theirsDoc, theirs, true);
  if (sameCanvasText(theirs, base)) return cleanCanvasResult(baseDoc, mineDoc, mineDoc, theirsDoc, mine, true);
  const result = mergeCanvas(baseDoc, mineDoc, theirsDoc);
  if (result.conflicts.length > 0) {
    return { kind: "conflict", conflicts: result.conflicts.length, review: { kind: "canvas", result, fromBase: true } };
  }
  const mergedText = serializeValidCanvas(result.merged);
  if (mergedText === null) return wholeCanvasConflict(mine, theirs);
  return { kind: "clean", text: mergedText, conflicts: 0, review: { kind: "canvas", result, fromBase: true } };
}

function twoWayBaseConflict(mine: string, theirs: string, budget: Budget): FileMerge {
  const fallback = twoWayRegions(mine, theirs, budget);
  const regions: Region[] = conflictsIn(fallback) > 0 ? fallback : [{ kind: "conflict", mine, theirs }];
  return {
    kind: "conflict",
    conflicts: conflictsIn(regions),
    review: { kind: "text", regions, format: "base", fromBase: false },
  };
}

function mergeBaseFile(base: string | null, mine: string, theirs: string, budget: Budget): FileMerge {
  if (mine === theirs || withoutFinalBreaks(mine) === withoutFinalBreaks(theirs) || sameBaseText(mine, theirs)) {
    return cleanText(theirs, mine, "base", base !== null);
  }
  if (base !== null && sameBaseText(mine, base)) return cleanText(theirs, mine, "base", true);
  if (base !== null && sameBaseText(theirs, base)) return cleanText(mine, mine, "base", true);
  if (base === null) return twoWayBaseConflict(mine, theirs, budget);

  const mineValid = isValidBaseYaml(mine);
  const theirsValid = isValidBaseYaml(theirs);
  const regions = mergeRegions(base, mine, theirs, budget);
  const count = conflictsIn(regions);
  if (count === 0) {
    const mergedText = theirsStanding(regions);
    if ((mineValid || theirsValid) && !isValidBaseYaml(mergedText)) return twoWayBaseConflict(mine, theirs, budget);
    return cleanText(mergedText, mine, "base", true, regions);
  }
  const allMine = resolvedRegions(regions, Array.from({ length: count }, () => "mine"));
  const allTheirs = resolvedRegions(regions, Array.from({ length: count }, () => "theirs"));
  if ((mineValid && (allMine === null || !isValidBaseYaml(allMine))) || (theirsValid && (allTheirs === null || !isValidBaseYaml(allTheirs)))) {
    return twoWayBaseConflict(mine, theirs, budget);
  }
  return { kind: "conflict", conflicts: count, review: { kind: "text", regions, format: "base", fromBase: true } };
}

function mergeNoteFile(base: string | null, mine: string, theirs: string, budget: Budget): FileMerge {
  if (mine === theirs || withoutFinalBreaks(mine) === withoutFinalBreaks(theirs)) return cleanText(theirs, mine, "note", base !== null);
  if (base !== null) {
    const regions = mergeRegions(base, mine, theirs, budget);
    const count = conflictsIn(regions);
    if (count > 0) return { kind: "conflict", conflicts: count, review: { kind: "text", regions, format: "note", fromBase: true } };
    return cleanText(theirsStanding(regions), mine, "note", true, regions);
  }
  const regions = twoWayRegions(mine, theirs, budget);
  const count = conflictsIn(regions);
  return count > 0
    ? { kind: "conflict", conflicts: count, review: { kind: "text", regions, format: "note", fromBase: false } }
    : cleanText(theirs, mine, "note", false, regions);
}

export function mergeFile(path: string, base: string | null, mine: string, theirs: string, budget: Budget): FileMerge {
  const format = reviewFormatOf(path);
  if (format === "canvas") return mergeCanvasFile(base, mine, theirs);
  if (format === "base") return mergeBaseFile(base, mine, theirs, budget);
  return mergeNoteFile(base, mine, theirs, budget);
}

export function buildReviewRequest(
  path: string,
  review: ReviewPayload,
  options: { other: ReviewSide; signal: AbortSignal },
): ReviewRequest {
  return { name: noteName(path), ...review, other: options.other, signal: options.signal };
}
