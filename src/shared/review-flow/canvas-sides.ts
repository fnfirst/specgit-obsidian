export type CanvasSide = "top" | "right" | "bottom" | "left";

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function sideToward(from: CanvasRect, to: CanvasRect): CanvasSide | null {
  const [a, b] = [rounded(from), rounded(to)];
  if (![a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const centre = (card: CanvasRect): { x: number; y: number } => ({ x: (card.x + (card.x + card.width)) / 2, y: (card.y + (card.y + card.height)) / 2 });
  const [at, toward] = [centre(a), centre(b)];
  const angle = Math.atan2(toward.y - at.y, toward.x - at.x);
  const diagonal = Math.atan2(a.height, a.width);
  if (angle > -diagonal && angle <= diagonal) return "right";
  if (angle > diagonal && angle <= Math.PI - diagonal) return "bottom";
  if (angle > Math.PI - diagonal || angle <= -(Math.PI - diagonal)) return "left";
  return "top";
}

const rounded = (card: CanvasRect): CanvasRect => ({ x: Math.round(card.x), y: Math.round(card.y), width: Math.round(card.width), height: Math.round(card.height) });
