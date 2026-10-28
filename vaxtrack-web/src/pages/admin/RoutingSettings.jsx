import { useEffect, useState } from "react";
import { MapPinned, Route } from "lucide-react";
import ClinicLocationSection from "./ClinicLocationSection";
import { saveRoutingSettings, subscribeRoutingSettings } from "../../services/routingSettingsService";
import {
  ROUTING_LIMITS,
  SUGGESTED_HUB,
  routingFormValues,
  routingSettingsOf,
  validateRoutingSettings,
} from "../../services/routingSettings";
import { friendlyErrorMessage, liveErrorMessage } from "../../services/liveDataErrors";

/**
 * Admin → Settings → Routing: the hub every planned trip departs from, and the
 * defaults the Dispatcher's departure planner starts with. Saved to
 * operationsSettings/routing; a real write, read live by Cargo Loading.
 *
 * Until an Admin saves, nothing is planned from the hub: the form is only
 * pre-filled with the pharmacy's pin (SUGGESTED_HUB) for convenience.
 */
function RoutingSettings({ showToast }) {
  const [stored, setStored] = useState(undefined); // undefined = loading, null = never saved
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      subscribeRoutingSettings(
        (docData) => {
          setStored(docData);
          setLoadError("");
          // Fill the form once; later snapshots never overwrite typing in progress.
          setForm((current) => current ?? routingFormValues(docData));
        },
        (err) => setLoadError(liveErrorMessage(err, "routing settings"))
      ),
    []
  );

  if (loadError) {
    return (
      <p className="routing-settings-state" role="alert">
        {loadError}
      </p>
    );
  }
  if (stored === undefined || !form) {
    return (
      <p className="routing-settings-state" role="status">
        Loading routing settings…
      </p>
    );
  }

  const saved = routingSettingsOf(stored);
  const update = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
  };

  async function save(event) {
    event.preventDefault();
    const check = validateRoutingSettings(form);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setSaving(true);
    try {
      await saveRoutingSettings(form);
      showToast?.("Routing settings saved. Departure plans now use them.", "success");
    } catch (err) {
      showToast?.(friendlyErrorMessage(err, "The routing settings could not be saved. Nothing changed — try again."), "error");
    } finally {
      setSaving(false);
    }
  }

  const field = (key, label, unit, hint) => (
    <label htmlFor={`routing-${key}`}>
      {label}
      <input
        id={`routing-${key}`}
        type="number"
        inputMode="numeric"
        step="1"
        min={ROUTING_LIMITS[key][0]}
        max={ROUTING_LIMITS[key][1]}
        value={form[key]}
        onChange={(e) => update({ [key]: e.target.value })}
        aria-invalid={errors[key] ? "true" : undefined}
        aria-describedby={`routing-${key}-hint`}
        disabled={saving}
      />
      <small id={`routing-${key}-hint`} className={errors[key] ? "routing-settings-error" : "routing-settings-hint"}>
        {errors[key] || `${hint} (${ROUTING_LIMITS[key][0]}–${ROUTING_LIMITS[key][1]} ${unit}).`}
      </small>
    </label>
  );

  return (
    <form className="settings-v3-card routing-settings" onSubmit={save} noValidate>
      <div className="settings-card-title">
        <Route size={17} />
        <h2>Routing</h2>
      </div>
      <p className="settings-readonly-lede">
        Dispatchers plan each rider&apos;s departure from this hub with motorcycle travel times, then save it as the
        trip. These values are the starting point; a dispatcher can change any number for one plan.
      </p>

      {!saved.hub && (
        <p className="routing-settings-notice" role="status">
          <MapPinned size={15} aria-hidden="true" />
          No hub is saved yet, so departure plans cannot route from it. The form is pre-filled with{" "}
          {SUGGESTED_HUB.name}&apos;s map pin — check it and save.
        </p>
      )}

      <div className="settings-form-grid">
        <label htmlFor="routing-hubName" className="routing-settings-wide">
          Hub name
          <input
            id="routing-hubName"
            type="text"
            maxLength={ROUTING_LIMITS.hubNameLength}
            value={form.hubName}
            onChange={(e) => update({ hubName: e.target.value })}
            aria-invalid={errors.hubName ? "true" : undefined}
            disabled={saving}
          />
          {errors.hubName && <small className="routing-settings-error">{errors.hubName}</small>}
        </label>
      </div>

      <ClinicLocationSection
        idPrefix="routing-hub"
        heading="Hub location"
        showRadius={false}
        value={{ latitude: form.latitude, longitude: form.longitude }}
        onChange={(patch) => update(patch)}
        errors={{ latitude: errors.latitude, longitude: errors.longitude }}
        disabled={saving}
        helpText="Click the map to place the hub, or drag the pin. Every planned trip's motorcycle route starts here, so place it where riders leave from."
        mapAriaLabel="Hub location picker. Click the map to place the pin, or use the latitude and longitude fields below."
        emptyMessage="No pin placed. Departure plans cannot route until the hub has a location."
      />
      {errors.location && <p className="routing-settings-error">{errors.location}</p>}

      <div className="settings-form-grid three">
        {field("serviceMinutes", "Time at each stop (min)", "min", "Handover and cold-chain check at each destination")}
        {field("trafficBufferPercent", "Traffic buffer (%)", "%", "Added to every motorcycle travel time — there is no live traffic")}
        {field("longWaitMinutes", "Long-wait warning (min)", "min", "Flag a wait longer than this at one stop")}
      </div>

      <div className="settings-action-row">
        <button type="submit" className="settings-primary-action" disabled={saving}>
          {saving ? "Saving…" : "Save routing settings"}
        </button>
      </div>
    </form>
  );
}

export default RoutingSettings;
