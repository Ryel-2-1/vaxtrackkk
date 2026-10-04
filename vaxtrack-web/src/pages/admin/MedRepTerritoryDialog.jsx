import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, MapPinned, X } from "lucide-react";
import { subscribeAreas } from "../../services/areaService";
import { subscribeClinics } from "../../services/clinicService";
import { subscribeDeliveries } from "../../services/deliveryService";
import { updateMedRepTerritory } from "../../services/userService";
import {
  clinicsOutsideAreas,
  openOrdersLosingTerritory,
  readTerritory,
  uniqueIds,
} from "../../services/territory";

/**
 * Admin → Staff Directory → Manage territory, for one Med Rep.
 *
 * Areas first, then clinics inside the selected areas. A Home destination is
 * permitted by its area alone; a Clinic destination needs the clinic itself
 * selected. Saving writes only the two territory lists (never role or status)
 * through updateMedRepTerritory, which re-validates everything in a
 * transaction; order creation enforces the result on the server.
 *
 * Removing an assignment never rewrites an order. When open orders already use
 * a destination the new territory drops, the Admin is warned and must confirm.
 */
export default function MedRepTerritoryDialog({ person, onClose, onSaved }) {
  const initial = useMemo(() => readTerritory(person.territorySource), [person.territorySource]);
  const [areas, setAreas] = useState([]);
  const [clinics, setClinics] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState({ areas: true, clinics: true });
  const [loadError, setLoadError] = useState("");
  const [areaIds, setAreaIds] = useState(initial.areaIds);
  const [clinicIdsState, setClinicIds] = useState(initial.clinicIds);
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmingOrders, setConfirmingOrders] = useState(null);
  const savingRef = useRef(false);

  useEffect(() => {
    const unsubAreas = subscribeAreas(
      (docs) => {
        setAreas(docs);
        setLoading((l) => ({ ...l, areas: false }));
      },
      () => {
        setLoading((l) => ({ ...l, areas: false }));
        setLoadError("Areas could not be loaded.");
      }
    );
    const unsubClinics = subscribeClinics(
      (docs) => {
        setClinics(docs);
        setLoading((l) => ({ ...l, clinics: false }));
      },
      () => {
        setLoading((l) => ({ ...l, clinics: false }));
        setLoadError("Clinics could not be loaded.");
      }
    );
    // Only to warn about open orders; a failure here never blocks saving.
    const unsubOrders = subscribeDeliveries((docs) => setOrders(docs), () => setOrders([]));
    return () => {
      unsubAreas();
      unsubClinics();
      unsubOrders();
    };
  }, []);

  const busy = loading.areas || loading.clinics;
  const areaById = useMemo(() => new Map(areas.map((a) => [a.id, a])), [areas]);
  // A clinic whose area is no longer selected can never stay selected.
  const clinicIds = useMemo(
    () => clinicIdsState.filter((id) => !clinicsOutsideAreas([id], areaIds, clinics).length),
    [clinicIdsState, areaIds, clinics]
  );

  // Active areas, plus any already-assigned area that has since been
  // deactivated, so the Admin can see it and remove it.
  const listedAreas = useMemo(
    () => areas.filter((a) => a.active === true || initial.areaIds.includes(a.id)),
    [areas, initial.areaIds]
  );
  const missingAreaIds = initial.areaIds.filter((id) => !areaById.has(id));
  // A deleted area cannot be kept; it is dropped from what is saved.
  const existingAreaIds = uniqueIds(areaIds.filter((id) => areaById.has(id)));

  const toggleArea = (id) => {
    setErrors([]);
    if (areaIds.includes(id)) {
      const next = areaIds.filter((a) => a !== id);
      const dropped = clinicsOutsideAreas(clinicIds, next, clinics);
      setAreaIds(next);
      setClinicIds(clinicIds.filter((c) => !dropped.includes(c)));
      setNotice(
        dropped.length
          ? `${dropped.length} clinic${dropped.length === 1 ? "" : "s"} in ${areaById.get(id)?.name || "that area"} ${dropped.length === 1 ? "was" : "were"} removed with the area.`
          : ""
      );
    } else {
      setAreaIds([...areaIds, id]);
      setNotice("");
    }
  };

  const toggleClinic = (id) => {
    setErrors([]);
    setNotice("");
    setClinicIds(clinicIds.includes(id) ? clinicIds.filter((c) => c !== id) : [...clinicIds, id]);
  };

  const submit = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErrors([]);
    try {
      await updateMedRepTerritory(person.uid, { areaIds: existingAreaIds, clinicIds: uniqueIds(clinicIds) });
      onSaved(`Territory saved for ${person.name}.`);
    } catch (error) {
      setErrors(error?.messages ?? [error?.message || "The territory could not be saved."]);
      setConfirmingOrders(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (savingRef.current) return;
    const affected = openOrdersLosingTerritory(orders, person.uid, { areaIds: existingAreaIds, clinicIds });
    if (affected.length > 0 && !confirmingOrders) {
      setConfirmingOrders(affected);
      return;
    }
    submit();
  };

  const selectedAreas = areaIds.map((id) => areaById.get(id)).filter(Boolean);
  const unchanged =
    existingAreaIds.join("|") === initial.areaIds.join("|") &&
    uniqueIds(clinicIds).join("|") === initial.clinicIds.join("|");

  return (
    <div className="settings-modal-backdrop">
      <div
        className="settings-modal territory-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="territory-title"
      >
        <button type="button" className="settings-modal-close" onClick={onClose} aria-label="Close" disabled={saving}>
          <X size={18} />
        </button>

        <h2 id="territory-title">
          <MapPinned size={18} aria-hidden="true" /> Manage territory
        </h2>
        <p className="territory-sub">
          {person.name} · Med Rep. Home destinations follow the selected areas; a
          clinic destination also needs the clinic selected. Removing an
          assignment does not change existing orders.
        </p>

        {busy ? (
          <p className="territory-muted" role="status">Loading areas and clinics…</p>
        ) : loadError ? (
          <p className="territory-error" role="alert">{loadError}</p>
        ) : (
          <div className="territory-body">
            <section aria-labelledby="territory-areas">
              <h3 id="territory-areas">Areas</h3>
              {listedAreas.length === 0 ? (
                <p className="territory-muted">No active areas exist yet. Add one in Admin → Clinics → Manage Areas.</p>
              ) : (
                <ul className="territory-list">
                  {listedAreas.map((area) => (
                    <li key={area.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={areaIds.includes(area.id)}
                          onChange={() => toggleArea(area.id)}
                          disabled={saving}
                        />
                        <span>{area.name || area.id}</span>
                        {area.active !== true && <em className="territory-flag">Inactive — remove</em>}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {missingAreaIds.length > 0 && (
                <p className="territory-muted">
                  {missingAreaIds.length} previously assigned area{missingAreaIds.length === 1 ? " no longer exists and" : "s no longer exist and"} will be removed on save.
                </p>
              )}
            </section>

            <section aria-labelledby="territory-clinics">
              <h3 id="territory-clinics">Clinics</h3>
              {selectedAreas.length === 0 ? (
                <p className="territory-muted">Select an area to choose its clinics.</p>
              ) : (
                selectedAreas.map((area) => {
                  const inArea = clinics.filter((c) => c.areaId === area.id);
                  return (
                    <div key={area.id} className="territory-group">
                      <h4>{area.name || area.id}</h4>
                      {inArea.length === 0 ? (
                        <p className="territory-muted">No clinics in this area.</p>
                      ) : (
                        <ul className="territory-list">
                          {inArea.map((clinic) => {
                            const wasAssigned = initial.clinicIds.includes(clinic.id);
                            const unverified = clinic.locationVerified !== true;
                            return (
                              <li key={clinic.id}>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={clinicIds.includes(clinic.id)}
                                    onChange={() => toggleClinic(clinic.id)}
                                    disabled={saving || (unverified && !wasAssigned)}
                                  />
                                  <span>{clinic.name || clinic.id}</span>
                                  <small>{clinic.area || area.name}</small>
                                  {unverified && <em className="territory-flag">No verified location</em>}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}
            </section>

            <section className="territory-summary" aria-live="polite">
              <strong>
                {existingAreaIds.length} area{existingAreaIds.length === 1 ? "" : "s"}, {clinicIds.length} clinic{clinicIds.length === 1 ? "" : "s"} selected
              </strong>
              {existingAreaIds.length === 0 && (
                <p>With no area, this Med Rep cannot place orders.</p>
              )}
              {notice && <p>{notice}</p>}
            </section>
          </div>
        )}

        {confirmingOrders && (
          <div className="territory-warning" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <strong>
                {confirmingOrders.length} open order{confirmingOrders.length === 1 ? " uses" : "s use"} a destination outside the new territory.
              </strong>
              <p>
                {confirmingOrders.slice(0, 3).map((o) => o.orderNumber || o.id).join(", ")}
                {confirmingOrders.length > 3 ? ` and ${confirmingOrders.length - 3} more` : ""}. They
                will not be changed or cancelled; only new orders follow the new territory.
              </p>
            </div>
          </div>
        )}

        {errors.length > 0 && (
          <ul className="territory-error" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="settings-modal-actions">
          <button
            type="button"
            className="settings-primary-action"
            onClick={handleSave}
            disabled={busy || Boolean(loadError) || saving || unchanged}
          >
            {saving ? "Saving…" : confirmingOrders ? "Save anyway" : "Save territory"}
          </button>
          <button
            type="button"
            className="settings-light-action"
            onClick={confirmingOrders ? () => setConfirmingOrders(null) : onClose}
            disabled={saving}
          >
            {confirmingOrders ? "Back" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
