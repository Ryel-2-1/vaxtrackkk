import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Package,
  Printer,
  RotateCcw,
  Truck,
  X,
} from "lucide-react";
import {
  finalizeRiderDispatch,
  subscribeCargoLoadingGroups,
  updateOrderLoadedState,
} from "../../services/cargoLoadingService";
import { getUserProfile } from "../../services/userService";
import { auth } from "../../firebase";
import DispatcherLayout from "./DispatcherLayout";
import StatusBadge from "../../components/ui/StatusBadge";
import KpiCard from "../../components/ui/KpiCard";
import "./CargoLoading.css";

// Loading-state badge shown on each rider card. Text + icon (not colour alone)
// so the state is clear without relying on colour perception.
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

function initialsOf(name) {
  return (
    (name || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
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

  const summary = useMemo(() => {
    const riders = groups.length;
    const ordersToLoad = groups.reduce((sum, g) => sum + (g.totalOrders || 0), 0);
    const loaded = groups.reduce((sum, g) => sum + (g.loadedCount || 0), 0);
    const ready = groups.filter(
      (g) => g.allLoaded && !dispatchedRiders[g.riderId]
    ).length;
    return { riders, ordersToLoad, loaded, ready };
  }, [groups, dispatchedRiders]);

  const showToast = (msg, type = "success") => {
    setToast(msg);
    setToastType(type);
  };

  const handleToggleLoaded = async (order, nextLoaded) => {
    if (savingOrders[order.id]) return; // block duplicate writes
    setSavingOrders((prev) => ({ ...prev, [order.id]: true }));
    try {
      // statusKey lets the service promote assigned → loading on confirmation.
      await updateOrderLoadedState(
        order.id,
        nextLoaded,
        dispatcher,
        order.statusKey
      );
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
        <div className="cl-state">
          <Loader2 size={30} className="cl-spin" />
          <p>Loading cargo data...</p>
        </div>
      </DispatcherLayout>
    );
  }

  if (error) {
    return (
      <DispatcherLayout active="cargo-loading" title="VaxTrack Logistics">
        <div className="cl-state">
          <span className="cl-state-icon">
            <AlertTriangle size={20} />
          </span>
          <strong>Could not load cargo data</strong>
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
        <div className="cl-header">
          <h1>Cargo loading</h1>
          <p>Confirm each order as loaded, then finalize dispatch per rider.</p>
        </div>

        <section className="cl-summary">
          <KpiCard
            label="Riders"
            value={summary.riders}
            context="With orders to load"
            tone="neutral"
          />
          <KpiCard
            label="Orders to load"
            value={summary.ordersToLoad}
            context="Across all riders"
            tone="neutral"
          />
          <KpiCard
            label="Loaded"
            value={summary.loaded}
            context={`of ${summary.ordersToLoad} confirmed`}
            tone="success"
          />
          <KpiCard
            label="Ready to dispatch"
            value={summary.ready}
            context={summary.ready > 0 ? "Fully loaded" : "None ready yet"}
            tone={summary.ready > 0 ? "success" : "neutral"}
          />
        </section>

        {toast && (
          <div className={`cl-toast ${toastType === "error" ? "error" : ""}`}>
            {toastType === "error" ? (
              <AlertTriangle size={16} />
            ) : (
              <CheckCircle2 size={16} />
            )}
            <span>{toast}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setToast("")}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {groups.length === 0 ? (
          <div className="cl-empty">
            <span className="cl-empty-icon">
              <Package size={20} />
            </span>
            <strong>No assigned orders ready for loading</strong>
            <p>
              Orders appear here once a dispatcher assigns them to a rider.
            </p>
          </div>
        ) : (
          <>
            <div className="cl-note">
              <Info size={15} />
              <span>
                Live route mapping isn&apos;t active yet — orders follow each
                rider&apos;s delivery sequence below.
              </span>
            </div>

            <div className="cl-cards">
              {groups.map((group) => (
                <RiderCard
                  key={group.riderId}
                  group={group}
                  dispatched={!!dispatchedRiders[group.riderId]}
                  savingOrders={savingOrders}
                  finalizing={finalizingRider === group.riderId}
                  onToggleLoaded={handleToggleLoaded}
                  onPrint={() => setPrintGroup(group)}
                  onFinalize={() => setConfirmGroup(group)}
                />
              ))}
            </div>
          </>
        )}
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
  dispatched,
  savingOrders,
  finalizing,
  onToggleLoaded,
  onPrint,
  onFinalize,
}) {
  const badge = loadingBadge(group, dispatched);
  const canFinalize = group.allLoaded && !dispatched && !finalizing;
  const total = group.totalOrders || 0;
  const loaded = group.loadedCount || 0;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <section className="cl-card" aria-label={`Loading sheet for ${group.rider.name}`}>
      <header className="cl-card-head">
        <span className="cl-avatar" aria-hidden="true">
          {initialsOf(group.rider.name)}
        </span>

        <div className="cl-rider-meta">
          <strong>{group.rider.name}</strong>
          <small>
            {group.rider.plate ? (
              <span className="cl-plate">{group.rider.plate}</span>
            ) : (
              "No plate on file"
            )}
          </small>
        </div>

        <span className={`cl-badge cl-badge-${badge.tone}`}>
          {badge.tone === "ready" || badge.tone === "dispatched" ? (
            <CheckCircle2 size={12} />
          ) : (
            <span className="cl-badge-dot" />
          )}
          {badge.label}
        </span>
      </header>

      <div className="cl-progress">
        <div className="cl-progress-row">
          <span className="tnum">
            {loaded}/{total} loaded
          </span>
          <span className="cl-progress-pct tnum">{pct}%</span>
        </div>
        <div className="cl-progress-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="cl-order-list">
        {group.orders.map((order, index) => {
          const checkboxId = `loaded-${order.id}`;
          const saving = !!savingOrders[order.id];
          const isLoaded = order.isLoaded === true;
          const seq = Number.isFinite(Number(order.deliverySequence))
            ? Number(order.deliverySequence)
            : index + 1;

          return (
            <div
              key={order.id}
              className={`cl-order-row ${isLoaded ? "loaded" : ""}`}
            >
              <span className="cl-seq tnum">
                {String(seq).padStart(2, "0")}
              </span>

              <div className="cl-order-info">
                <div className="cl-order-top">
                  <strong>{orderClinic(order)}</strong>
                  <StatusBadge statusKey={order.statusKey} />
                </div>
                <small className="cl-order-vaccine">
                  {order.vaccineName || "Unknown vaccine"}
                  <span className="tnum">
                    {" · "}
                    {(order.quantity || 0).toLocaleString()} {order.unit || "doses"}
                  </span>
                  {order.batchId ? ` · Batch ${order.batchId}` : ""}
                </small>
              </div>

              <label
                htmlFor={checkboxId}
                className={`cl-check ${isLoaded ? "on" : ""}`}
              >
                <input
                  type="checkbox"
                  id={checkboxId}
                  checked={isLoaded}
                  disabled={saving || dispatched}
                  onChange={(e) => onToggleLoaded(order, e.target.checked)}
                />
                {saving ? (
                  <Loader2 size={13} className="cl-spin" />
                ) : (
                  <span className="cl-check-text">
                    {isLoaded ? "Loaded" : "Confirm"}
                  </span>
                )}
              </label>
            </div>
          );
        })}
      </div>

      {!group.allLoaded && !dispatched && (
        <p className="cl-hint">Confirm all orders as loaded to enable dispatch.</p>
      )}

      <div className="cl-card-actions">
        <button
          type="button"
          className="cl-btn cl-btn-outline"
          onClick={onPrint}
        >
          <Printer size={14} /> Print sheet
        </button>

        <button
          type="button"
          className="cl-btn cl-btn-primary"
          disabled={!canFinalize}
          aria-disabled={!canFinalize}
          onClick={onFinalize}
        >
          {finalizing ? <Loader2 size={14} className="cl-spin" /> : <Truck size={14} />}
          {dispatched ? "Dispatched" : "Finalize dispatch"}
        </button>
      </div>
    </section>
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
            <Truck size={14} /> Confirm dispatch
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
