import { STATUS_SUBMIT_STEP, statusOpenComments } from "../review-flow";
import { CloseIcon } from "./icons";
import { buttonsOff, Face, runningLabel, type Ctx } from "./shared";
import type { StatusReviewer } from "./types";

export function SubmitStep({
  ids,
  reviewers,
  documents,
  openComments,
  ctx,
  onBack,
  onSubmit,
}: {
  ids: readonly string[];
  reviewers: readonly StatusReviewer[];
  documents: number;
  openComments: number;
  ctx: Ctx;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const warning = statusOpenComments(openComments, documents, ctx.noun);
  return (
    <div className="sp-footer sp-step" data-testid="sp-footer">
      <div className="sp-step-title">{STATUS_SUBMIT_STEP.title(documents, ctx.noun)}</div>
      {warning ? <p className="sp-step-warning">{warning}</p> : null}
      <div className="sp-label">{STATUS_SUBMIT_STEP.reviewers}</div>
      <div className="sp-chips">
        {reviewers.map((one) => (
          <span key={one.login} className="sp-chip">
            <Face login={one.login} url={one.avatarUrl} />
            <span>{one.login}</span>
            <button type="button" className="sp-icon-button" aria-label={STATUS_SUBMIT_STEP.remove(one.login)} disabled={buttonsOff(ctx)} onClick={() => ctx.act({ type: "remove-reviewer", login: one.login })}>
              <CloseIcon />
            </button>
          </span>
        ))}
        <button type="button" className="sp-chip sp-chip-add" disabled={buttonsOff(ctx)} onClick={() => ctx.act({ type: "add-reviewer", ids })}>
          {STATUS_SUBMIT_STEP.add}
        </button>
      </div>
      <div className="sp-footer-buttons">
        <button type="button" className="sp-btn" onClick={onBack}>
          {STATUS_SUBMIT_STEP.back}
        </button>
        <button type="button" className="sp-btn sp-primary" disabled={buttonsOff(ctx)} onClick={onSubmit}>
          {runningLabel(ctx, "submit", STATUS_SUBMIT_STEP.submit)}
        </button>
      </div>
    </div>
  );
}
