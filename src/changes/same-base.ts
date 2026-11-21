import { isMap, parseDocument } from "yaml";
import { type ParsedBase, sameBaseTextWith } from "../shared/review-flow";

function parseBase(text: string): ParsedBase {
  try {
    const doc = parseDocument(text, { logLevel: "silent" });
    if (doc.errors.length > 0) return null;
    if (doc.contents !== null && !isMap(doc.contents)) return null;
    const value: unknown = doc.toJS({ maxAliasCount: 100 });
    return { value };
  } catch {
    return null;
  }
}

export const sameBaseText = (a: string, b: string): boolean => sameBaseTextWith(a, b, parseBase);
