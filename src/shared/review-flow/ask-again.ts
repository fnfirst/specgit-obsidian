export const ASK_AGAIN_MAX = 6;
export const ASK_AGAIN_MS = 1_200;

export const UNSCANNED_AGAIN_MS = 5_000;

export interface AnswerLevel {
  stale?: boolean;
  unscanned?: number;

  pending?: boolean;

  failed?: boolean;

  unread?: boolean;
}

export const isLevel = (answer: AnswerLevel): boolean => answer.stale !== true && !((answer.unscanned ?? 0) > 0) && answer.pending !== true && answer.failed !== true && answer.unread !== true;

export class AskAgain {
  private asked = 0;

  after(answer: AnswerLevel): number | null {
    if (isLevel(answer) || this.asked >= ASK_AGAIN_MAX) {
      this.asked = 0;
      return null;
    }
    this.asked += 1;
    const wait = ASK_AGAIN_MS * this.asked;

    return answer.stale || answer.pending || answer.failed || answer.unread ? wait : Math.max(UNSCANNED_AGAIN_MS, wait);
  }

  reset(): void {
    this.asked = 0;
  }
}
