export function frontmatterRegion(text: string): string {
  const firstEnd = text.indexOf("\n");
  if (firstEnd < 0) return "";
  const fence = text.slice(0, firstEnd).trimEnd();
  if (fence !== "---" && fence !== "+++") return "";
  let start = firstEnd + 1;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end < 0 ? text.length : end);
    if (line.trimEnd() === fence) return text.slice(0, end < 0 ? text.length : end + 1);
    if (end < 0) return "";
    start = end + 1;
  }
  return "";
}

export const bodyOf = (text: string): string => text.slice(frontmatterRegion(text).length);
