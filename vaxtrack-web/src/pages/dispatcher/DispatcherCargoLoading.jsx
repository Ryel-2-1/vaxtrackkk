import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  MapPin,
  Package,
  Printer,
  RotateCcw,
  Route,
  Truck,
  User,
  X,
} from "lucide-react";
import {
  finalizeRiderDispatch,
  subscribeCargoLoadingGroups,
  updateOrderLoadedState,
} from "../../services/cargoLoadingService";
import { getUserProfile } from "../../services/userService";
import { mapOrderStatusLabel } from "../../services/deliveryService";
import { auth } from "../../firebase";
import DispatcherLayout from "./DispatcherLayout";
import "./CargoLoading.css";

// Loading-status badge shown on each rider card. Uses text + icon (not color
// alone) so the state is clear without relying on colour perception.
function loadingBadge(group, dispatched) {
  if (dispatched) return { label: "Dispatched", tone: "dispatched" };
  if (group.allLoaded) return { label: "Ready", tone: "ready" };
  return { label: "Pending", tone: "pending" };
}

function orderAddress(order) {
  return order.deliveryAddress || order.clinicAddress || "";
}

function orderClinic(order) {
  return order.clinicName || order.clinic || "Unknown clinic";
}

function formatNow() {
  return new Date().toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function DispatcherCargoLoading() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedRiderId, setSelectedRiderId] = useState(null);

  const [dispatcher, setDispatcher] = useState(() => {
    const user = auth.currentUser;
    return {
      uid: user?.uid || null,
      email: user?.email || null,
      name: user?.displayName || "",
    };
  });

  const [savingOrders, setSavingOrders] = useState({}); // orderId -> true while writing
  const [finalizingRider, setFinalizingRider] = useState(null);
  const [dispatchedRiders, setDispatchedRiders] = useState({}); // riderId -> true (just dispatched)

  const [confirmGroup, setConfirmGroup] = useState(null); // group awaiting finalize confirmation
  const [printGroup, setPrintGroup] = useState(null); // group being printed
  const [toast, setToast] = useState("");
  const [toastType, setToastType] = useState("success");

  // Enrich the dispatcher name from the Firestore profile (async, so it does
  // not count as a synchronous setState in the effect body).
  useEffect(() => {
    const user = auth.currentUser;
    if (!user) return;
    getUserProfile(user.uid)
      .then((profile) => {
        if (profile) {
          setDispatcher((prev) => ({
            ...prev,
            name: profile.fullName || profile.name || profile.displayName || prev.name,
          }));
        }
      })
      .catch(() => {
        /* non-fatal: fall back to auth email */
      });
  }, []);

  // Live subscription to rider loading groups.
  useEffect(() => {
    const unsub = subscribeCargoLoadingGroups(
      (next) => {
        setGroups(next);
        setLoading(false);
        setError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view cargo loading.");
        } else {
          setError("Unable to load cargo loading data.");
        }
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  // Derive the effective selection during render (React-recommended over an
  // effect): honour the user's pick when it still exists, else fall back to
  // the first group. `setSelectedRiderId` only runs on an explicit click.
  const effectiveRiderId = useMemo(() => {
    if (groups.length === 0) return null;
    if (selectedRiderId && groups.some((g) => g.riderId === selectedRiderId)) {
      return selectedRiderId;
    }
    return groups[0].riderId;
  }, [groups, selectedRiderId]);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.riderId === effectiveRiderId) || null,
    [groups, effectiveRiderId]
  );

  const showToast = (msg, type = "success") => {
    setToast(msg);
    setToastType(type);
  };

  const handleToggleLoaded = async (order, nextLoaded) => {
    if (savingOrders[order.id]) return; // block duplicate writes
    setSavingOrders((prev) => ({ ...prev, [order.id]: true }));
    try {
      await updateOrderLoadedState(order.id, nextLoaded, dispatcher);
    } catch (err) {
      console.error("updateOrderLoadedState error:", err);
      showToast(err.message || "Failed to save loaded state.", "error");
    } finally {
      setSavingOrders((prev) => {
        const copy = { ...prev };
        delete copy[order.id];
        return copy;
      });
    }
  };

  const handleFinalize = async (group) => {
    if (!group || finalizingRider) return;
    setFinalizingRider(group.riderId);
    setConfirmGroup(null);
    try {
      await finalizeRiderDispatch(
        group.riderId,
        group.orders.map((o) => o.id),
        dispatcher
      );
      // Show the "Dispatched" state briefly; the snapshot then removes the group.
      setDispatchedRiders((prev) => ({ ...prev, [group.riderId]: true }));
      showToast(`Dispatch finalized for ${group.rider.name}.`, "success");
    } catch (err) {
      console.error("finalizeRiderDispatch error:", err);
      showToast(err.message || "Failed to finalize dispatch.", "error");
    } finally {
      setFinalizingRider(null);
    }
  };

  // Trigger the browser print dialog once the print sheet has rendered.
  useEffect(() => {
    if (!printGroup) return;
    const handleAfterPrint = () => setPrintGroup(null);
    window.addEventListener("afterprint", handleAfterPrint);
    const timer = window.setTimeout(() => window.print(), 60);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, [printGroup]);

  if (loading) {
    return (
      <DispatcherLayout active="cargo-loading" title="VaxTrack Logistics">
        <div className="dispatcher-loading-state">
          <Loader2 size={32} className="cl-spin" />
          <p>Loading cargo loading data...</p>
        </div>
      </DispatcherLayout>
    );
  }

  if (error) {
    return (
      <DispatcherLayout active="cargo-loading" title="VaxTrack Logistics">
        <div className="dispatcher-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
          <button
            type="button"
            className="cl-btn cl-btn-outline"
            onClick={() => {
              setError("");
              setLoading(true);
            }}
          >
            <RotateCcw size={14} /> Retry
          </button>
        </div>
      </DispatcherLayout>
    );
  }

  return (
    <DispatcherLayout active="cargo-loading" title="VaxTrack Logistics">
      <div className="dispatcher-v2-page">
        <div className="dispatcher-v2-header">
          <h1>Dispatcher: Route Preview &amp; Loading Sheets</h1>
          <p>Review and prepare assigned orders and route details for final dispatch.</p>
        </div>

        {toast && (
          <div className={`alerts-v2-toast ${toastType === "error" ? "error" : ""}`}>
            {toastType === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{toast}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => setToast("")}>
              <X size={14} />
            </button>
          </div>
        )}

        {groups.length === 0 ? (
          <div className="dispatcher-empty-queue">
            <Package size={28} />
            <p>No riders currently have assigned orders awaiting loading.</p>
          </div>
        ) : (
          <div className="cl-grid">
            <div className="cl-left">
              {groups.map((group) => (
                <RiderCard
                  key={group.riderId}
                  group={group}
                  selected={group.riderId === effectiveRiderId}
                  dispatched={!!dispatchedRiders[group.riderId]}
                  savingOrders={savingOrders}
                  finalizing={finalizingRider === group.riderId}
                  onSelect={() => setSelectedRiderId(group.riderId)}
                  onToggleLoaded={handleToggleLoaded}
                  onPrint={() => setPrintGroup(group)}
                  onFinalize={() => setConfirmGroup(group)}
                />
              ))}
            </div>

            <aside className="cl-right">
              <RoutePreviewPanel
                group={selectedGroup}
                dispatched={selectedGroup ? !!dispatchedRiders[selectedGroup.riderId] : false}
                finalizing={selectedGroup ? finalizingRider === selectedGroup.riderId : false}
                onFinalize={() => selectedGroup && setConfirmGroup(selectedGroup)}
              />
            </aside>
          </div>
        )}

        <footer className="dispatcher-v2-footer">
          <span>&copy; 2026 VaxTrack Logistics. All rights reserved.</span>
        </footer>
      </div>

      {confirmGroup && (
        <ConfirmDispatchDialog
          group={confirmGroup}
          onCancel={() => setConfirmGroup(null)}
          onConfirm={() => handleFinalize(confirmGroup)}
        />
      )}

      {printGroup && (
        <PrintSheet group={printGroup} dispatcher={dispatcher} printedAt={formatNow()} />
      )}
    </DispatcherLayout>
  );
}

function RiderCard({
  group,
  selected,
  dispatched,
  savingOrders,
  finalizing,
  onSelect,
  onToggleLoaded,
  onPrint,
  onFinalize,
}) {
  const badge = loadingBadge(group, dispatched);
  const canFinalize = group.allLoaded && !dispatched && !finalizing;

  return (
    <section
      className={`cl-rider-card ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onFocus={onSelect}
      aria-label={`Loading sheet for ${group.rider.name}`}
    >
      <header className="cl-rider-head">
        <div className="cl-rider-avatar" aria-hidden="true">
          <User size={18} />
        </div>

        <div className="cl-rider-meta">
          <strong>{group.rider.name}</strong>
          <small>
            {group.rider.plate ? `Plate ${group.rider.plate}` : "No plate on file"}
            {" · "}
            {group.totalOrders} {group.totalOrders === 1 ? "order" : "orders"}
          </small>
        </div>

        <span className={`cl-badge cl-badge-${badge.tone}`}>
          {badge.tone === "ready" || badge.tone === "dispatched" ? (
            <CheckCircle2 size={12} />
          ) : (
            <Circle size={12} />
          )}
          {badge.label}
        </span>
      </header>

      <div className="cl-order-list">
        {group.orders.map((order, index) => {
          const checkboxId = `loaded-${order.id}`;
          const saving = !!savingOrders[order.id];
          const seq = Number.isFinite(Number(order.deliverySequence))
            ? Number(order.deliverySequence)
            : index + 1;

          return (
            <div key={order.id} className="cl-order-row">
              <span className="cl-seq">#{String(seq).padStart(2, "0")}</span>

              <div className="cl-order-info">
                <strong>{orderClinic(order)}</strong>
                {orderAddress(order) && <small>{orderAddress(order)}</small>}
                <p>
                  {order.vaccineName || "Unknown vaccine"}
                  {order.batchId ? ` · Batch ${order.batchId}` : ""}
                </p>
                <span className="cl-order-qty">
                  Qty: {(order.quantity || 0).toLocaleString()} {order.unit || "doses"}
                  {" · "}
                  <span className="cl-order-status">{mapOrderStatusLabel(order.statusKey)}</span>
                </span>
              </div>

              <div className="cl-load-check">
                <input
                  type="checkbox"
                  id={checkboxId}
                  checked={order.isLoaded === true}
                  disabled={saving || dispatched}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onToggleLoaded(order, e.target.checked)}
                />
                <label htmlFor={checkboxId}>
                  {saving ? (
                    <Loader2 size={12} className="cl-spin" />
                  ) : (
                    <span className="cl-load-label-text">
                      {order.isLoaded === true ? "Loaded" : "Confirm loaded"}
                    </span>
                  )}
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="cl-rider-actions">
        <button
          type="button"
          className="cl-btn cl-btn-outline"
          onClick={(e) => {
            e.stopPropagation();
            onPrint();
          }}
        >
          <Printer size={14} /> Print Sheet
        </button>

        <button
          type="button"
          className="cl-btn cl-btn-primary"
          disabled={!canFinalize}
          aria-disabled={!canFinalize}
          onClick={(e) => {
            e.stopPropagation();
            onFinalize();
          }}
        >
          {finalizing ? <Loader2 size={14} className="cl-spin" /> : <Truck size={14} />}
          {dispatched ? "Dispatched" : "Finalize Dispatch"}
        </button>
      </div>

      {!group.allLoaded && !dispatched && (
        <p className="cl-hint">Confirm all orders as loaded to enable dispatch.</p>
      )}
    </section>
  );
}

function RoutePreviewPanel({ group, dispatched, finalizing, onFinalize }) {
  const canFinalize = group && group.allLoaded && !dispatched && !finalizing;

  return (
    <div className="cl-route-card">
      <div className="cl-route-head">
        <Route size={15} />
        <strong>Route Preview</strong>
      </div>

      {!group ? (
        <div className="cl-route-empty">
          <MapPin size={22} />
          <p>Select a rider to preview their route.</p>
        </div>
      ) : (
        <>
          {/* No clinic coordinates / route integration exist yet, so the map
              area shows a clear empty state instead of a decorative fake route. */}
          <div className="cl-map-placeholder" role="img" aria-label="Route map unavailable">
            <MapPin size={22} />
            <p>
              Route preview unavailable because destination coordinates have not been
              configured.
            </p>
          </div>

          <div className="cl-route-facts">
            <div>
              <span>Selected Rider</span>
              <strong>{group.rider.name}</strong>
            </div>
            <div>
              <span>First Stop</span>
              <strong>{group.orders[0] ? orderClinic(group.orders[0]) : "—"}</strong>
            </div>
            <div>
              <span>Next Stop</span>
              <strong>{group.orders[1] ? orderClinic(group.orders[1]) : "—"}</strong>
            </div>
            <div>
              <span>ETA</span>
              <strong>Not available</strong>
            </div>
            <div>
              <span>Total Distance</span>
              <strong>Not available</strong>
            </div>
            <div>
              <span>Route Status</span>
              <strong>
                {dispatched ? "Dispatched" : group.allLoaded ? "Ready to dispatch" : "Awaiting loading"}
              </strong>
            </div>
          </div>

          <div className="cl-timeline">
            <span className="cl-timeline-title">Delivery Sequence</span>
            {group.orders.map((order, index) => {
              const seq = Number.isFinite(Number(order.deliverySequence))
                ? Number(order.deliverySequence)
                : index + 1;
              return (
                <div key={order.id} className={`cl-timeline-item ${order.isLoaded ? "done" : ""}`}>
                  <span className="cl-timeline-dot" aria-hidden="true" />
                  <div>
                    <small>{order.plannedTime || "Not scheduled"}</small>
                    <strong>
                      #{String(seq).padStart(2, "0")} {orderClinic(order)}
                    </strong>
                    <em>{mapOrderStatusLabel(order.statusKey)}</em>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className="cl-btn cl-btn-primary cl-btn-full"
            disabled={!canFinalize}
            aria-disabled={!canFinalize}
            onClick={onFinalize}
          >
            {finalizing ? <Loader2 size={14} className="cl-spin" /> : <Truck size={14} />}
            {dispatched ? "Dispatched" : "Finalize Dispatch"}
          </button>
        </>
      )}
    </div>
  );
}

function ConfirmDispatchDialog({ group, onCancel, onConfirm }) {
  // Close the dialog with the Escape key for keyboard accessibility.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="cl-dialog-overlay" onClick={onCancel}>
      <div
        className="cl-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cl-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="cl-dialog-title">Finalize dispatch?</h2>
        <p>
          This will mark all {group.totalOrders} order
          {group.totalOrders === 1 ? "" : "s"} for <strong>{group.rider.name}</strong> as{" "}
          <strong>In Transit</strong>. This action cannot be undone here.
        </p>
        <div className="cl-dialog-actions">
          <button type="button" className="cl-btn cl-btn-outline" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="cl-btn cl-btn-primary" onClick={onConfirm} autoFocus>
            <Truck size={14} /> Confirm Dispatch
          </button>
        </div>
      </div>
    </div>
  );
}

function PrintSheet({ group, dispatcher, printedAt }) {
  return (
    <div className="cl-print-area">
      <div className="cl-print-header">
        <h1>VaxTrack — Loading Sheet</h1>
        <p>{printedAt}</p>
      </div>

      <table className="cl-print-meta">
        <tbody>
          <tr>
            <th>Rider</th>
            <td>{group.rider.name}</td>
            <th>Vehicle Plate</th>
            <td>{group.rider.plate || "—"}</td>
          </tr>
          <tr>
            <th>Total Orders</th>
            <td>{group.totalOrders}</td>
            <th>Dispatcher</th>
            <td>{dispatcher.name || dispatcher.email || "—"}</td>
          </tr>
        </tbody>
      </table>

      <table className="cl-print-table">
        <thead>
          <tr>
            <th>Seq</th>
            <th>Clinic &amp; Address</th>
            <th>Vaccine</th>
            <th>Batch ID</th>
            <th>Qty</th>
            <th>Loaded</th>
          </tr>
        </thead>
        <tbody>
          {group.orders.map((order, index) => {
            const seq = Number.isFinite(Number(order.deliverySequence))
              ? Number(order.deliverySequence)
              : index + 1;
            return (
              <tr key={order.id}>
                <td>#{String(seq).padStart(2, "0")}</td>
                <td>
                  <strong>{orderClinic(order)}</strong>
                  {orderAddress(order) && <div>{orderAddress(order)}</div>}
                </td>
                <td>{order.vaccineName || "—"}</td>
                <td>{order.batchId || "—"}</td>
                <td>
                  {(order.quantity || 0).toLocaleString()} {order.unit || "doses"}
                </td>
                <td>{order.isLoaded === true ? "YES" : "NO"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="cl-print-signoff">
        <p>Prepared by: {dispatcher.name || dispatcher.email || "—"}</p>
        <p>Rider signature: ____________________________</p>
      </div>
    </div>
  );
}

export default DispatcherCargoLoading;
