import { Notice } from "./Feedback";

/**
 * Says that the record being edited changed elsewhere, and offers the two
 * ways forward. Pair with useLiveDraft: while `labels` is non-empty the form
 * blocks saving, so stale values are never written without a decision.
 *
 *   labels  — readable names of the fields that changed ("Phone number")
 *   gone    — the record no longer exists; nothing can be saved
 *   what    — what is being edited ("your profile", "this clinic's location")
 */
export default function StaleEditNotice({ labels = [], gone = false, what, onLoadLatest, onKeepMine, disabled = false }) {
  if (gone) {
    return (
      <Notice tone="error" title={`${what[0].toUpperCase()}${what.slice(1)} no longer exists`}>
        It was removed in another session, so these changes can't be saved.
      </Notice>
    );
  }
  if (labels.length === 0) return null;
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return (
    <Notice tone="warning" title="Changed in another session">
      <p className="m-stale-text">
        {list} {labels.length === 1 ? "was" : "were"} updated while you were editing {what}. Load the latest
        {labels.length === 1 ? " value" : " values"}, or keep yours and save it. Your other changes are kept either way.
      </p>
      <div className="m-stale-actions">
        <button type="button" className="m-btn m-btn-primary" onClick={onLoadLatest} disabled={disabled}>
          Load latest
        </button>
        <button type="button" className="m-btn m-btn-secondary" onClick={onKeepMine} disabled={disabled}>
          Keep mine
        </button>
      </div>
    </Notice>
  );
}
