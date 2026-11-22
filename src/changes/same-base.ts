import { isMap, parseAllDocuments } from "yaml";
import { type ParsedBase, sameBaseTextWith } from "../shared/review-flow";

function parseBase(text: string): ParsedBase {
  const clean = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  try {
    const docs = parseAllDocuments(clean, { logLevel: "silent" });
    if (docs.length > 1) return null;
    if (docs.length === 0) return { value: null };
    const doc = docs[0]!;
    if (doc.errors.length > 0) return null;
    if (doc.contents !== null && !isMap(doc.contents)) return null;
    const value: unknown = doc.toJS({ maxAliasCount: 100 });
    return { value };
  } catch {
    return null;
  }
}

export const isValidBaseYaml = (text: string): boolean => parseBase(text) !== null;

export const sameBaseText = (a: string, b: string): boolean => sameBaseTextWith(a, b, parseBase);
