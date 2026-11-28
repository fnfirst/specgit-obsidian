import { Notice } from "obsidian";

export const ACTION_MS = 15_000;

const STACK_GAP_PX = 8;
const stacked: HTMLElement[] = [];
let stackWatch: MutationObserver | null = null;

function restack(): void {
  for (let i = stacked.length - 1; i >= 0; i--) if (!stacked[i]!.isConnected) stacked.splice(i, 1);
  let lift = 0;
  for (let i = stacked.length - 1; i >= 0; i--) {
    stacked[i]!.style.setProperty("--specgit-notice-lift", `${lift}px`);
    lift += stacked[i]!.offsetHeight + STACK_GAP_PX;
  }
  if (stacked.length === 0) {
    stackWatch?.disconnect();
    stackWatch = null;
  }
}

function stack(notice: Notice): void {
  const box = notice.containerEl;
  box.classList.add("specgit-notice-lasting-host");
  stacked.push(box);
  const container = box.parentElement;
  if (container && !stackWatch) {
    stackWatch = new MutationObserver(restack);
    stackWatch.observe(container, { childList: true });
  }
  restack();
}

export function showNotice(message: string, lasting = false): void {
  const notice = new Notice(message, lasting ? 0 : undefined);
  if (lasting) stack(notice);
}

export function showProgress(message: string): { set(message: string): void; hide(): void } {
  const notice = new Notice(message, 0);
  return { set: (words) => void notice.setMessage(words), hide: () => notice.hide() };
}

let awareNotices = false;

export function setAwareNotices(on: boolean): void {
  awareNotices = on;
}

export type NoticeHandle = ((message: string) => void) & {
  hide(): void;
  shown(): boolean;
};

export function showNoticeWithAction(message: string, label: string, run: () => void, lasting = false): NoticeHandle {
  let words: HTMLElement | null = null;
  const duration = lasting ? 0 : ACTION_MS;
  const act = (): void => {
    notice.hide();
    run();
  };
  const notice: Notice = new Notice(
    createFragment((fragment) => {
      if (!awareNotices) {
        const body = fragment.createSpan();
        words = body.createSpan({ text: message });
        body.createEl("button", { text: label, cls: "specgit-notice-action" }, (button) => button.addEventListener("click", act));
        return;
      }
      const body = fragment.createSpan({ cls: "specgit-notice-body" });
      words = body.createSpan({ text: message });
      body.createEl("a", { text: label, cls: "specgit-notice-link", attr: { href: "#", role: "button" } }, (link) =>
        link.addEventListener("click", (event) => {
          event.preventDefault();
          act();
        }),
      );
    }),
    duration,
  );
  if (lasting) stack(notice);
  const update = ((text: string): void => (words ? void words.setText(text) : void notice.setMessage(text))) as NoticeHandle;
  update.hide = () => notice.hide();
  update.shown = () => notice.messageEl.isConnected;
  return update;
}

export function showNoticeWithActions(message: string, actions: ReadonlyArray<{ label: string; run: () => void }>, lasting = true): { shown(): boolean; hide(): void } {
  const notice: Notice = new Notice(
    createFragment((fragment) => {
      const body = fragment.createSpan({ cls: "specgit-notice-body" });
      body.createSpan({ text: message });
      for (const action of actions) {
        body.createEl("a", { text: action.label, cls: "specgit-notice-link", attr: { href: "#", role: "button" } }, (link) =>
          link.addEventListener("click", (event) => {
            event.preventDefault();
            notice.hide();
            action.run();
          }),
        );
      }
    }),
    lasting ? 0 : ACTION_MS,
  );
  if (lasting) stack(notice);
  return { shown: () => notice.messageEl.isConnected, hide: () => notice.hide() };
}
