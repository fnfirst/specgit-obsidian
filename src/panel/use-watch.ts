import { useEffect, useState } from "preact/hooks";

export function useWatch<Value>(subscribe: (listener: () => void) => () => void, read: () => Value): Value {
  const [, again] = useState(0);
  useEffect(() => subscribe(() => again((count) => count + 1)), [subscribe]);
  return read();
}

export const NEVER = (): (() => void) => () => undefined;
