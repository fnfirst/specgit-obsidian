export interface WordPart {
  text: string;
  changed: boolean;
}

const MAX_PAIRS = 250_000;

const tokens = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? [];

export function wordDiff(mine: string, theirs: string): { mine: WordPart[]; theirs: WordPart[] } | null {
  const a = tokens(mine);
  const b = tokens(theirs);
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_PAIRS) return null;
  const width = b.length + 1;
  const length = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      length[i * width + j] = a[i] === b[j] ? length[(i + 1) * width + j + 1]! + 1 : Math.max(length[(i + 1) * width + j]!, length[i * width + j + 1]!);
    }
  }
  const sameA = new Array<boolean>(a.length).fill(false);
  const sameB = new Array<boolean>(b.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      sameA[i] = true;
      sameB[j] = true;
      i++;
      j++;
    } else if (length[(i + 1) * width + j]! >= length[i * width + j + 1]!) i++;
    else j++;
  }
  return { mine: runs(a, sameA), theirs: runs(b, sameB) };
}

function runs(words: readonly string[], same: readonly boolean[]): WordPart[] {
  const parts: WordPart[] = [];
  words.forEach((word, at) => {
    const space = /^\s+$/.test(word);
    const changed = space ? (parts.at(-1)?.changed ?? false) && same[at + 1] === false : !same[at];
    const last = parts.at(-1);
    if (last && last.changed === changed) last.text += word;
    else parts.push({ text: word, changed });
  });
  return parts;
}
