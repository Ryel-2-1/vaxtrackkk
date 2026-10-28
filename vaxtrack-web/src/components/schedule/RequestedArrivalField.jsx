import { useId } from "react";
import { Clock3 } from "lucide-react";
import {
  ARRIVAL_MODE_OPTIONS,
  EMPTY_ARRIVAL_FORM,
  withArrivalMode,
} from "../../services/requestedArrival";

/**
 * The optional requested ARRIVAL at the destination (services/requestedArrival.js).
 *
 * Structured controls only: a preference, then just the times that preference
 * needs. Nothing is prefilled — "any time within the requested day" is the
 * default and needs no time at all — and Clear returns to it. `<input
 * type="time">` gives 'HH:MM' (24-hour) whatever the device's locale or
 * timezone, so what is typed is exactly what is sent.
 *
 * `problem` is a failed check ({ field, message }) or null; the input it names is
 * marked invalid and described by the message.
 */
function RequestedArrivalField({ value, onChange, problem = null, disabled = false, summary = "" }) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const mode = value?.mode ?? "any_time";

  const timeInput = (field, label) => {
    const invalid = problem?.field === field;
    return (
      <label className="arrival-time" htmlFor={`${id}-${field}`}>
        <span>{label}</span>
        <input
          id={`${id}-${field}`}
          type="time"
          step="60"
          value={value?.[field] ?? ""}
          disabled={disabled}
          required
          aria-required="true"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={invalid ? `${errorId} ${helpId}` : helpId}
          onChange={(event) => onChange({ ...value, [field]: event.target.value })}
        />
      </label>
    );
  };

  return (
    <fieldset className="arrival-field" disabled={disabled}>
      <legend>
        <Clock3 size={14} aria-hidden="true" />
        Requested delivery time <span className="arrival-optional">(optional)</span>
      </legend>
      <p id={helpId} className="arrival-help">
        When the delivery should arrive at the destination on the requested date, in Philippine time — not
        when the rider leaves the hub. It is a request for planning, not a guaranteed time.
      </p>

      <label className="arrival-mode" htmlFor={`${id}-mode`}>
        <span>Arrival preference</span>
        <select
          id={`${id}-mode`}
          value={mode}
          aria-describedby={helpId}
          aria-invalid={problem?.field === "mode" ? "true" : undefined}
          onChange={(event) => onChange(withArrivalMode(value, event.target.value))}
        >
          {ARRIVAL_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {mode === "window" && (
        <div className="arrival-times">
          {timeInput("start", "From")}
          {timeInput("end", "Until")}
        </div>
      )}
      {mode === "before" && <div className="arrival-times">{timeInput("time", "Arrive before")}</div>}
      {mode === "exact" && <div className="arrival-times">{timeInput("time", "Arrive at")}</div>}

      {problem ? (
        <p id={errorId} className="arrival-error" role="alert">
          {problem.message}
        </p>
      ) : (
        summary && (
          <p className="arrival-summary" aria-live="polite">
            {summary}
          </p>
        )
      )}

      {mode !== "any_time" && (
        <button
          type="button"
          className="arrival-clear"
          onClick={() => onChange({ ...EMPTY_ARRIVAL_FORM })}
        >
          Clear time preference
        </button>
      )}
    </fieldset>
  );
}

export default RequestedArrivalField;
