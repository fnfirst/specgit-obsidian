import { isHiddenPath, LISTED_FILE } from "../mapping";

export interface LeftOut {
  html: number;
  image: number;
  pdf: number;
  other: number;
}

export const NOTHING_LEFT_OUT: LeftOut = { html: 0, image: 0, pdf: 0, other: 0 };

const HTML = /\.html?$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|heic|tiff?)$/i;
const PDF = /\.pdf$/i;

export const isLeftOutKind = (path: string): boolean => !LISTED_FILE.test(path) && !isHiddenPath(path);

export function leftOutKinds(paths: Iterable<string>): LeftOut {
  const left = { ...NOTHING_LEFT_OUT };
  for (const path of paths) {
    if (!isLeftOutKind(path)) continue;
    if (HTML.test(path)) left.html++;
    else if (IMAGE.test(path)) left.image++;
    else if (PDF.test(path)) left.pdf++;
    else left.other++;
  }
  return left;
}

export const leftOutTotal = (left: LeftOut): number => left.html + left.image + left.pdf + left.other;
