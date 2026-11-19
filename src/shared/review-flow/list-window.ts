export const WINDOWED_FROM = 60;

export const WINDOW_ROWS = 8;

export const WINDOW_OVERSCAN = 6;

export interface ListWindow {

  start: number;

  end: number;
  before: number;
  after: number;
}

export function listWindow(total: number, scrollTop: number, rowHeight: number, viewRows = WINDOW_ROWS, overscan = WINDOW_OVERSCAN): ListWindow {
  if (total <= WINDOWED_FROM) return { start: 0, end: total, before: 0, after: 0 };
  const first = Math.min(Math.max(0, Math.floor(scrollTop / rowHeight)), total - 1);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + viewRows + overscan);
  return { start, end, before: start * rowHeight, after: (total - end) * rowHeight };
}
