export function reportIfNotChosen(chosen: () => boolean, dismissed: () => void): void {
  window.setTimeout(() => {
    if (!chosen()) dismissed();
  }, 0);
}
