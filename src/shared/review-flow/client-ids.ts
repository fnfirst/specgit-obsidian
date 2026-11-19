export const BRIDGE_CLIENT_FLOOR = 0xf0000000;

export function personClientId(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * (BRIDGE_CLIENT_FLOOR - 1));
}
