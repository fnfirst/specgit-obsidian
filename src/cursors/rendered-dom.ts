import { type BlockModel, type Part, partAt, partsIn, placeable, renderedIndex, renderedSpan } from "./rendered-text";

interface Rendered {
  value: string;
  points: Array<{ node: Text; offset: number }>;
}

const SHOW_TEXT = 4;

function renderedOf(root: Element): Rendered {
  const found: Rendered = { value: "", points: [] };
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    for (let offset = 0; offset < text.data.length; offset++) found.points.push({ node: text, offset });
    found.value += text.data;
  }
  return found;
}

function partElement(block: Element, part: Part): Element | null {
  if (part.kind === "title") return block.querySelector(".callout-title-inner");
  if (part.kind === "body") return block.querySelector(".callout-content");
  return block.querySelector("table")?.rows[part.row]?.cells[part.col] ?? null;
}

function rangeOf(rendered: Rendered, start: number, end: number): Range | null {
  let last = rendered.value.length;
  while (last > 0 && !/[^\s\u200b]/.test(rendered.value[last - 1]!)) last--;
  const at = (index: number): { node: Text; offset: number } | null => {
    if (last > 0 && index >= last) {
      const point = rendered.points[last - 1];
      return point ? { node: point.node, offset: point.offset + 1 } : null;
    }
    return rendered.points[index] ?? null;
  };
  const [from, to] = [at(start), at(end)];
  if (!from || !to) return null;
  const range = from.node.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

export function caretRange(block: Element, model: BlockModel, offset: number): Range | null {
  const part = partAt(model, offset);
  const element = part && partElement(block, part);
  if (!part || !element) return null;
  const rendered = renderedOf(element);
  const index = renderedIndex(part, rendered.value, offset);
  return index === null ? null : rangeOf(rendered, index, index);
}

export function selectionRanges(block: Element, model: BlockModel, from: number, to: number): Range[] | null {
  const ranges: Range[] = [];
  for (const part of partsIn(model, from, to)) {
    const element = partElement(block, part);
    if (!element) return null;
    const rendered = renderedOf(element);
    if (!placeable(part, rendered.value)) return null;
    const span = renderedSpan(part, rendered.value, from, to);
    const range = span && rangeOf(rendered, span.start, span.end);
    if (range) ranges.push(range);
  }
  return ranges.length > 0 ? ranges : null;
}
