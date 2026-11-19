declare const setTimeout: (run: () => void, ms: number) => unknown;
declare const clearTimeout: (id: unknown) => void;

export const timeout = (run: () => void, ms: number): (() => void) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};
