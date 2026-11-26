import { stripBom, toLf, withBomAndEol } from "../disk/line-endings";

export async function writeIfHolds(
  process: (edit: (current: string) => string) => Promise<unknown>,
  expected: string,
  text: string,
  onWrite?: (written: string) => void,
): Promise<boolean> {
  let wrote = false;
  let written = "";
  await process((current) => {
    if (stripBom(toLf(current)) !== stripBom(toLf(expected))) return current;
    wrote = true;
    written = stripBom(text) === "" ? "" : current === "" ? text : withBomAndEol(toLf(text), current);
    return written;
  });
  if (wrote) onWrite?.(written);
  return wrote;
}
