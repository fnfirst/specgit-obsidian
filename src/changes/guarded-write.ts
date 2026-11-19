import { toLf } from "../disk/line-endings";

export async function writeIfHolds(process: (edit: (current: string) => string) => Promise<unknown>, expected: string, text: string): Promise<boolean> {
  let wrote = false;
  await process((current) => {
    if (toLf(current) !== toLf(expected)) return current;
    wrote = true;
    return text;
  });
  return wrote;
}
