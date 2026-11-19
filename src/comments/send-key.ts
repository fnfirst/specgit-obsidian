export function sendFrom(active: Element | null): boolean {
  const button = active?.closest("[data-send-scope]")?.querySelector<HTMLButtonElement>("[data-send]");
  if (!button || button.disabled) return false;
  button.click();
  return true;
}
