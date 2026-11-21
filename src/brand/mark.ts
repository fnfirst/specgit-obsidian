export const MARK_ICON = "specgit";

export const TAGLINE = "Edit your notes live with your team, and send them for review in your own GitHub repo.";

const ICON_PAGE = "M22 6H68L86 24V86A8 8 0 0 1 78 94H22A8 8 0 0 1 14 86V14A8 8 0 0 1 22 6ZM47 6V94";
const ICON_LINES = "M24 30H38M24 50H38M24 70H38";
const ICON_BRANCH = "M61 33V67M61 61C61 55 64 52 68 51";
const ICON_NODES: ReadonlyArray<readonly [number, number]> = [
  [61, 27],
  [61, 73],
  [74, 49],
];

export const MARK_SVG =
  `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">` +
  `<path stroke-width="7" d="${ICON_PAGE}"/><path stroke-width="6" d="${ICON_LINES}"/><path stroke-width="5" d="${ICON_BRANCH}"/>` +
  ICON_NODES.map(([x, y]) => `<circle stroke-width="5" cx="${x}" cy="${y}" r="6"/>`).join("") +
  `</g>`;

const SVG_NS = "http://www.w3.org/2000/svg";
const BRANCH_GRADIENT = "specgit-logo-branch";

const GRADIENT_STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, "#0167fb"],
  [0.306, "#0072f9"],
  [0.566, "#0094e3"],
  [0.825, "#00b5c8"],
  [1, "#00b7ac"],
];

type Shape = { tag: "path" | "circle"; attrs: Record<string, string>; cls?: "specgit-logo-paper" | "specgit-logo-outline" | "specgit-logo-lines" };

const LOGO_SHAPES: readonly Shape[] = [
  { tag: "path", cls: "specgit-logo-paper", attrs: { d: "M298.5 268.2A38 38 0 0 1 337.7 229L644.7 229Q651.9 229 651.9 236.2L651.9 963.3Q651.9 974.5 640.7 974.5L337.7 974.5A38 38 0 0 1 298.5 935.3Z" } },
  {
    tag: "path",
    cls: "specgit-logo-outline",
    attrs: {
      "fill-rule": "evenodd",
      d: "M262.8 269.4A76.7 76.7 0 0 1 339.5 192.7L831.01 192.7A34.5 34.5 0 0 1 855.4 202.8L957.53 304.93A75 75 0 0 1 979.5 357.97L979.5 441.1A10.6 10.6 0 0 1 958.3 441.1L954.51 378.81C953.61 363.88 944.29 343.19 933.71 332.61L834.84 233.74Q831.3 230.2 826.3 230.2L681.1 230.2Q674.1 230.2 674.1 237.2L674.1 928.6C674.1 959.3 703.9 992.5 733.8 992.5A10.2 10.2 0 0 1 733.8 1012.9L338.6 1012.9A75.8 75.8 0 0 1 262.8 937.1ZM299.7 268.2A38 38 0 0 1 337.7 230.2L644.7 230.2Q650.7 230.2 650.7 236.2L650.7 963.3Q650.7 973.3 640.7 973.3L337.7 973.3A38 38 0 0 1 299.7 935.3Z",
    },
  },
  { tag: "path", attrs: { fill: "none", stroke: "#006dfc", "stroke-width": "17", "stroke-linecap": "round", d: "M364.9 319.9V376.6M411.9 319.9V376.6M364.9 348.4H411.9" } },
  { tag: "path", cls: "specgit-logo-lines", attrs: { fill: "none", "stroke-width": "25.7", "stroke-linecap": "round", d: "M465.9 347.3H580.1M368.5 429.3H580.3M519.8 563.6H580.3M368.4 657.4H580.3M435.9 776.4H583M435.8 866.4H582.9" } },
  { tag: "path", attrs: { fill: "none", stroke: "#00aebf", "stroke-width": "15.6", "stroke-linecap": "round", "stroke-linejoin": "round", d: "M380.8 541.8 363.4 563.3 380.8 584.1M424.3 532.1 408 593.4M451.9 541.8 469.4 563.5 451.9 584.1" } },
  { tag: "circle", attrs: { cx: "372.4", cy: "776.1", r: "14.9", fill: "#00b0c4" } },
  { tag: "circle", attrs: { cx: "372.4", cy: "865.8", r: "14.9", fill: "#00b3b9" } },
  {
    tag: "path",
    attrs: {
      fill: "none",
      stroke: `url(#${BRANCH_GRADIENT})`,
      "stroke-width": "29.1",
      d: "M781.3 409.8V829.3M781.3 718.3C781.3 650.7 822.8 609 897.4 575.5M738.6 368a42.8 42.8 0 1 0 85.6 0a42.8 42.8 0 1 0 -85.6 0M890.6 551.3a42.8 42.8 0 1 0 85.6 0a42.8 42.8 0 1 0 -85.6 0M738.6 871.5a42.8 42.8 0 1 0 85.6 0a42.8 42.8 0 1 0 -85.6 0",
    },
  },
  { tag: "circle", cls: "specgit-logo-paper", attrs: { cx: "781.4", cy: "368", r: "28.8" } },
  { tag: "circle", cls: "specgit-logo-paper", attrs: { cx: "933.4", cy: "551.3", r: "28.8" } },
  { tag: "circle", cls: "specgit-logo-paper", attrs: { cx: "781.4", cy: "871.5", r: "28.8" } },
];

const LOGO_VIEW_BOX = "181.5 163 880 880";

const svgElement = <K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string>, cls?: string): SVGElementTagNameMap[K] => {
  const element = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  if (cls) element.setAttribute("class", cls);
  return element;
};

export function drawLogo(parent: HTMLElement): SVGSVGElement {
  const doc = parent.ownerDocument;
  const svg = svgElement(doc, "svg", { viewBox: LOGO_VIEW_BOX, role: "img", "aria-label": "specgit" }, "specgit-logo");
  const defs = svgElement(doc, "defs", {});
  const gradient = svgElement(doc, "linearGradient", { id: BRANCH_GRADIENT, gradientUnits: "userSpaceOnUse", x1: "0", y1: "311", x2: "0", y2: "928" });
  for (const [offset, colour] of GRADIENT_STOPS) gradient.appendChild(svgElement(doc, "stop", { offset: String(offset), "stop-color": colour }));
  defs.appendChild(gradient);
  svg.appendChild(defs);
  for (const shape of LOGO_SHAPES) svg.appendChild(svgElement(doc, shape.tag, shape.attrs, shape.cls));
  parent.replaceChildren(svg);
  return svg;
}
