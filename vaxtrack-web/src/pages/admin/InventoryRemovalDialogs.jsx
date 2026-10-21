// Admin Inventory — removal controls: Remove unusable stock (quarantine /
// dispose), Void batch, Manage vaccines (archive / restore), and the batch's
// removal history.
//
// Every action is a server callable (services/inventoryRemovalService.js →
// functions/src/inventoryRemoval.js) that re-checks everything inside one
// transaction; the checks here only explain up front what the server would
// refuse. Dialogs are portaled through InventoryDialog, so they centre in the
// viewport and stack above the batch details.
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { InventoryDialog } from "./InventoryBatchDialog";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import {
  newRequestId,
  removeUnusableStock,
  setVaccineArchived,
  subscribeBatchAuditEvents,
  voidInventoryBatch,
} from "../../services/inventoryRemovalService";
import {
  MAX_REMOVAL_TEXT,
  REMOVAL_REASONS,
  REMOVAL_REASON_LABELS,
  describeAuditEvent,
  readRemovalCounters,
  validateReasonText,
  validateStockRemoval,
  voidEligibility,
} from "../../services/inventoryRemovalModel";

const doses = (n) => `${n.toLocaleString()} dose${n === 1 ? "" : "s"}`;

function formatWhen(value) {
  const d = typeof value?.toDate === "function" ? value.toDate() : null;
  if (!d) return "Time pending";
  return d.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function CloseButton({ onClick }) {
  return (
    <button type="button" className="v2-inventory-modal-close" onClick={onClick} aria-label="Close">
      <X size={18} />
    </button>
  );
}

// ---------------------------------------------------------------- remove unusable stock

/**
 * Quarantine free doses, or dispose of quarantined ones. Figures come from the
 * LIVE batch row; a batch that disappears blocks the action.
 */
export function RemoveStockDialog({ item, live, gone, onClose, onDone }) {
  const current = live ?? item;
  const counters = readRemovalCounters(current.source);
  const [action, setAction] = useState(() =>
    counters && counters.free === 0 && counters.quarantined > 0 ? "dispose" : "quarantine"
  );
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState(() => (item.level === "expired" ? "expired" : ""));
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState(null); // { field, text } — a form problem, not an Error
  const [saving, setSaving] = useState(false);
  // One id per removal ATTEMPT, kept across retries of an uncertain call so
  // the server replays rather than removing twice.
  const [requestId, setRequestId] = useState(() => newRequestId());

  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : NaN;
  const limit = counters ? (action === "quarantine" ? counters.free : counters.quarantined) : 0;

  const submit = async () => {
    if (saving || gone) return;
    const check = validateStockRemoval({
      action,
      quantity: qty,
      reason,
      notes,
      batch: current.source,
      expired: current.level === "expired",
    });
    if (!check.ok) {
      setProblem({ field: check.field, text: check.message });
      return;
    }
    if (action === "dispose" && !confirmed) {
      setProblem({ field: "confirm", text: "Confirm that these doses have been physically disposed of." });
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const result = await removeUnusableStock({ requestId, inventoryId: item.id, ...check.value });
      onDone(
        action === "quarantine"
          ? `${doses(check.value.quantity)} of batch ${item.batch} moved to quarantine.${result?.replayed ? " (Already recorded.)" : ""}`
          : `${doses(check.value.quantity)} of batch ${item.batch} disposed of and written off.${result?.replayed ? " (Already recorded.)" : ""}`
      );
    } catch (err) {
      logSafeError("Remove unusable stock", err);
      // A reused id means an earlier attempt already went through: start a
      // fresh attempt after the Admin has checked the live figures.
      if (err?.code === "idempotency-conflict") setRequestId(newRequestId());
      setProblem({
        field: "submit",
        text: friendlyErrorMessage(err, "The stock could not be removed. Nothing was changed — please try again."),
      });
    } finally {
      setSaving(false);
    }
  };

  const consequence =
    action === "quarantine"
      ? "Quarantined doses stay on hand but are never offered to orders again. Reserved doses and returned doses awaiting a decision are not affected."
      : "Disposed doses are written off the on-hand count permanently and recorded in the batch history. This cannot be undone.";

  return (
    <InventoryDialog labelledBy="inv-remove-title" onClose={onClose} busy={saving} className="inv-price-modal inv-removal-modal">
      <CloseButton onClick={onClose} />
      <h2 id="inv-remove-title">Remove unusable stock</h2>
      <p className="inv-price-batch">
        <strong>{item.name}</strong>
        <span>Batch {item.batch}</span>
      </p>

      {counters ? (
        <dl className="inv-removal-counts">
          <div><dt>On hand</dt><dd>{counters.onHand.toLocaleString()}</dd></div>
          <div><dt>Reserved</dt><dd>{counters.reserved.toLocaleString()}</dd></div>
          <div><dt>Returned, awaiting decision</dt><dd>{counters.returnPending.toLocaleString()}</dd></div>
          <div><dt>Quarantined</dt><dd>{counters.quarantined.toLocaleString()}</dd></div>
          <div><dt>Free to quarantine</dt><dd>{counters.free.toLocaleString()}</dd></div>
        </dl>
      ) : (
        <p className="inv-removal-warning" role="alert">
          This batch's stock figures are not valid and need review before stock can be removed.
        </p>
      )}

      <fieldset className="inv-removal-options" disabled={saving}>
        <legend>Action</legend>
        <label>
          <input
            type="radio"
            name="inv-remove-action"
            value="quarantine"
            checked={action === "quarantine"}
            onChange={() => {
              setAction("quarantine");
              setConfirmed(false);
              setProblem(null);
            }}
          />
          <span>
            <strong>Quarantine free doses</strong>
            <small>Take damaged, expired or recalled doses out of available stock.</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="inv-remove-action"
            value="dispose"
            checked={action === "dispose"}
            onChange={() => {
              setAction("dispose");
              setProblem(null);
            }}
          />
          <span>
            <strong>Dispose of quarantined doses</strong>
            <small>Write off doses already in quarantine once they have been destroyed or returned.</small>
          </span>
        </label>
      </fieldset>

      <label htmlFor="inv-remove-reason">Reason</label>
      <select
        id="inv-remove-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={saving}
        aria-invalid={problem?.field === "reason" ? "true" : undefined}
      >
        <option value="">Choose a reason…</option>
        {REMOVAL_REASONS.map((r) => (
          <option key={r} value={r}>
            {REMOVAL_REASON_LABELS[r]}
          </option>
        ))}
      </select>

      <label htmlFor="inv-remove-qty">Doses to {action === "quarantine" ? "quarantine" : "dispose of"}</label>
      <input
        id="inv-remove-qty"
        type="number"
        min="1"
        step="1"
        inputMode="numeric"
        placeholder={limit > 0 ? `1 – ${limit.toLocaleString()}` : "None available"}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        disabled={saving}
        aria-invalid={problem?.field === "quantity" ? "true" : undefined}
        aria-describedby="inv-remove-help"
      />
      <small id="inv-remove-help">
        {action === "quarantine"
          ? `Up to ${doses(limit)} can be quarantined — only doses no order or return is holding.`
          : `Up to ${doses(limit)} can be disposed of — only doses already in quarantine.`}
      </small>

      <label htmlFor="inv-remove-notes">Note (optional, recorded for the audit trail)</label>
      <textarea
        id="inv-remove-notes"
        rows={2}
        maxLength={MAX_REMOVAL_TEXT}
        placeholder="e.g. Recall notice RN-2026-14, or vials cracked in storage"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={saving}
      />

      <p className="inv-removal-consequence">{consequence}</p>

      {action === "dispose" && (
        <label className="inv-removal-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={saving}
          />
          <span>I confirm these doses have been physically disposed of or returned to the supplier.</span>
        </label>
      )}

      <div aria-live="assertive">
        {gone && (
          <p className="inv-price-error" role="alert">
            This batch is no longer in inventory. Close this dialog.
          </p>
        )}
        {problem && (
          <p className="inv-price-error" role="alert">
            {problem.text}
          </p>
        )}
      </div>

      <div className="inv-price-actions">
        <button type="button" className="inv-price-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className={action === "dispose" ? "inv-price-save inv-danger-save" : "inv-price-save"}
          onClick={submit}
          disabled={saving || gone || !counters || limit === 0}
        >
          {saving
            ? "Saving…"
            : action === "quarantine"
              ? Number.isInteger(qty) && qty > 0 ? `Quarantine ${doses(qty)}` : "Quarantine doses"
              : Number.isInteger(qty) && qty > 0 ? `Dispose of ${doses(qty)}` : "Dispose of doses"}
        </button>
      </div>
    </InventoryDialog>
  );
}

// ---------------------------------------------------------------- void batch

export function VoidBatchDialog({ item, live, gone, onClose, onDone, onRemoveInstead }) {
  const current = live ?? item;
  const eligibility = voidEligibility(current.source);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving || gone || !eligibility.ok) return;
    const check = validateReasonText(reason, "reason for voiding this batch");
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await voidInventoryBatch({ inventoryId: item.id, reason: check.value });
      onDone(`Batch ${item.batch} was voided. It is kept as a record and hidden from ordering.`);
    } catch (err) {
      logSafeError("Void batch", err);
      setError(friendlyErrorMessage(err, "The batch could not be voided. Nothing was changed — please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <InventoryDialog labelledBy="inv-void-title" onClose={onClose} busy={saving} className="inv-price-modal inv-removal-modal">
      <CloseButton onClick={onClose} />
      <h2 id="inv-void-title">Void batch</h2>
      <p className="inv-price-batch">
        <strong>{item.name}</strong>
        <span>Batch {item.batch}</span>
      </p>

      <p className="inv-removal-consequence">
        Use this only for a batch that was entered by mistake. A voided batch is kept as an audit record, hidden from
        ordering and never counted as stock. This cannot be undone.
      </p>

      {!eligibility.ok ? (
        <div className="inv-removal-warning" role="note">
          <p>{eligibility.message}</p>
          {onRemoveInstead && eligibility.code !== "batch-voided" && (
            <button type="button" className="inv-price-cancel" onClick={onRemoveInstead}>
              Remove unusable stock instead
            </button>
          )}
        </div>
      ) : (
        <>
          <label htmlFor="inv-void-reason">Why is this batch a mistake? (recorded for the audit trail)</label>
          <textarea
            id="inv-void-reason"
            rows={2}
            maxLength={MAX_REMOVAL_TEXT}
            placeholder="e.g. Entered twice — the same delivery is batch LOT-1182"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
            aria-invalid={error ? "true" : undefined}
          />
        </>
      )}

      <div aria-live="assertive">
        {gone && (
          <p className="inv-price-error" role="alert">
            This batch is no longer in inventory. Close this dialog.
          </p>
        )}
        {error && (
          <p className="inv-price-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="inv-price-actions">
        <button type="button" className="inv-price-cancel" onClick={onClose} disabled={saving}>
          {eligibility.ok ? "Cancel" : "Close"}
        </button>
        {eligibility.ok && (
          <button type="button" className="inv-price-save inv-danger-save" onClick={submit} disabled={saving || gone}>
            {saving ? "Voiding…" : "Void batch"}
          </button>
        )}
      </div>
    </InventoryDialog>
  );
}

// ---------------------------------------------------------------- manage vaccines

/**
 * The vaccine products, active and archived, with Archive / Restore. An
 * archived product leaves Med Rep ordering and Add Stock; nothing it already
 * appears in changes.
 */
export function ManageVaccinesDialog({ vaccines, batchCounts, onClose, onDone }) {
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(null); // { vaccine, archived }
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...vaccines]
      .filter((v) => !q || `${v.vaccineName ?? ""} ${v.internalSku ?? ""} ${v.vaccineType ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) =>
        a.archived === b.archived
          ? String(a.vaccineName ?? "").localeCompare(String(b.vaccineName ?? ""))
          : a.archived ? 1 : -1
      );
  }, [vaccines, search]);

  // A product archived or restored elsewhere while this confirmation is open.
  const pendingLive = pending ? vaccines.find((v) => v.id === pending.vaccine.id) ?? null : null;
  const pendingStale = Boolean(pending) && (!pendingLive || (pendingLive.archived === true) === pending.archived);

  const begin = (vaccine, archived) => {
    setPending({ vaccine, archived });
    setReason("");
    setError("");
  };

  const submit = async () => {
    if (saving || !pending || pendingStale) return;
    let text = reason.trim();
    if (pending.archived) {
      const check = validateReasonText(reason, "reason for archiving");
      if (!check.ok) {
        setError(check.message);
        return;
      }
      text = check.value;
    } else if (text.length > MAX_REMOVAL_TEXT) {
      setError(`Please keep the reason under ${MAX_REMOVAL_TEXT} characters.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setVaccineArchived({ vaccineId: pending.vaccine.id, archived: pending.archived, reason: text });
      const name = pending.vaccine.vaccineName || "The vaccine";
      setPending(null);
      onDone(
        pending.archived
          ? `${name} was archived. It is no longer offered for new orders or new stock.`
          : `${name} was restored and can be ordered again.`
      );
    } catch (err) {
      logSafeError("Archive vaccine", err);
      setError(friendlyErrorMessage(err, "The vaccine could not be updated. Nothing was changed — please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <InventoryDialog labelledBy="inv-vaccines-title" onClose={onClose} busy={saving} className="inv-price-modal inv-removal-modal inv-vaccines-modal">
      <CloseButton onClick={onClose} />
      <h2 id="inv-vaccines-title">{pending ? (pending.archived ? "Archive vaccine" : "Restore vaccine") : "Manage vaccines"}</h2>

      {pending ? (
        <>
          <p className="inv-price-batch">
            <strong>{pending.vaccine.vaccineName || "Unnamed vaccine"}</strong>
            <span>{pending.vaccine.internalSku || "No SKU"}</span>
          </p>
          <p className="inv-removal-consequence">
            {pending.archived
              ? "Archiving removes this vaccine from Med Rep ordering and from Add Stock. Existing orders, reservations, batches and history are kept, and orders already waiting for it can still receive stock. You can restore it later."
              : "Restoring makes this vaccine available for new orders and new stock again."}
          </p>
          <label htmlFor="inv-archive-reason">
            {pending.archived ? "Reason (recorded for the audit trail)" : "Reason (optional, recorded for the audit trail)"}
          </label>
          <textarea
            id="inv-archive-reason"
            rows={2}
            maxLength={MAX_REMOVAL_TEXT}
            placeholder={pending.archived ? "e.g. Discontinued by the manufacturer" : "e.g. Supply resumed"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
            aria-invalid={error ? "true" : undefined}
          />
          <div aria-live="assertive">
            {pendingStale && (
              <p className="inv-price-error" role="alert">
                This vaccine changed while you were reviewing it. Go back to see its current state.
              </p>
            )}
            {error && (
              <p className="inv-price-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="inv-price-actions">
            <button type="button" className="inv-price-cancel" onClick={() => setPending(null)} disabled={saving}>
              Back
            </button>
            <button
              type="button"
              className={pending.archived ? "inv-price-save inv-danger-save" : "inv-price-save"}
              onClick={submit}
              disabled={saving || pendingStale}
            >
              {saving ? "Saving…" : pending.archived ? "Archive vaccine" : "Restore vaccine"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="inv-removal-consequence">
            Archived vaccines are hidden from new orders and Add Stock. Nothing is deleted.
          </p>
          <label htmlFor="inv-vaccines-search">Search vaccines</label>
          <input
            id="inv-vaccines-search"
            type="search"
            placeholder="Name, SKU or type"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="inv-vaccine-list">
            {rows.map((v) => (
              <li key={v.id} className={v.archived ? "is-archived" : ""}>
                <div>
                  <strong>{v.vaccineName || "Unnamed vaccine"}</strong>
                  <small>
                    {[v.internalSku, v.vaccineType, `${batchCounts.get(v.id) ?? 0} batch${(batchCounts.get(v.id) ?? 0) === 1 ? "" : "es"}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  {v.archived && <span className="inv-tag inv-tag-archived">Archived</span>}
                </div>
                <button type="button" className="inv-price-btn" onClick={() => begin(v, !v.archived)}>
                  {v.archived ? "Restore" : "Archive"}
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="inv-vaccine-empty">No vaccines match.</li>}
          </ul>
          <div className="inv-price-actions">
            <button type="button" className="inv-price-cancel" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </InventoryDialog>
  );
}

// ---------------------------------------------------------------- history

/** The batch's stock-change audit (correction, quarantine, disposal, void), newest first. */
export function BatchRemovalHistory({ inventoryId }) {
  const [state, setState] = useState({ id: null, events: [], error: "" });
  useEffect(
    () =>
      subscribeBatchAuditEvents(
        inventoryId,
        (events) => setState({ id: inventoryId, events, error: "" }),
        (err) => setState({ id: inventoryId, events: [], error: liveErrorMessage(err, "the stock change history") })
      ),
    [inventoryId]
  );
  const loading = state.id !== inventoryId;

  return (
    <section className="inv-removal-history" aria-label="Stock change history">
      <h3>Stock change history</h3>
      {loading ? (
        <p className="inv-removal-muted">Loading…</p>
      ) : state.error ? (
        <p className="inv-removal-muted" role="alert">{state.error}</p>
      ) : state.events.length === 0 ? (
        <p className="inv-removal-muted">No stock has been corrected, quarantined, disposed of or voided on this batch.</p>
      ) : (
        <ol>
          {state.events.map((e) => (
            <li key={e.id}>
              <strong>{describeAuditEvent(e)}</strong>
              <small>
                {formatWhen(e.at)} · {e.actorEmail || "Admin"}
              </small>
              {(e.notes || ((e.action === "batch_voided" || e.action === "stock_corrected") && e.reason)) && (
                <small className="inv-removal-note">{e.notes || e.reason}</small>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
