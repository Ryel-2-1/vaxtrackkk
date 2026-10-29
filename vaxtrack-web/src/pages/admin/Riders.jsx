import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleHelp,
  PhoneCall,
  Search,
  Users,
  X,
} from "lucide-react";
import { subscribeRiders, updateRiderStatus } from "../../services/riderService";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeRiderDispatchStates } from "../../services/riderDispatchService";
import { subscribeAllRiderLocations } from "../../services/riderTrackingService";
import { fleetOnTime, ordersByRider, riderActivity } from "../../services/riderActivity";
import { formatRate } from "../../services/deliveryMetrics";
import useMinuteClock from "../../components/useMinuteClock";
import KpiCard from "../../components/ui/KpiCard";
import { kpiValue, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { ToastRegion } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/useToast";
import RiderRecoveryPanel from "./RiderRecoveryPanel";
import "./Riders.css";

const UI_STATUS_MAP = {
  // "Active" is the ACCOUNT state. Whether an approved Rider is at the hub or
  // out on a trip comes from the server trip state (shown separately) — an
  // approved Rider on a trip is not "standby".
  approved: { uiStatus: "standby", statusText: "Active" },
  pending: { uiStatus: "offduty", statusText: "Pending Approval" },
  pending_approval: { uiStatus: "offduty", statusText: "Pending Approval" },
  disabled: { uiStatus: "offduty", statusText: "Off Duty" },
  rejected: { uiStatus: "offduty", statusText: "Rejected" },
};

function normalizeRider(raw) {
  const statusRaw = (raw.status || "pending").trim().toLowerCase();
  const mapped = UI_STATUS_MAP[statusRaw] || {
    uiStatus: "offduty",
    statusText: "Unknown",
  };

  const name =
    raw.fullName || raw.name || raw.displayName || raw.email || "Unnamed Rider";

  const vehicle =
    raw.vehiclePlate ||
    raw.motorcycle ||
    raw.motorcycleId ||
    raw.vehicle ||
    "Not assigned";

  const initials =
    name
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";

  return {
    uid: raw.uid,
    displayId: raw.employeeId || "—",
    name,
    email: raw.email || "—",
    phone: raw.phone || raw.contactNumber || "—",
    initials,
    vehicle,
    statusRaw,
    status: mapped.uiStatus,
    statusText: mapped.statusText,
  };
}

// Shown in place of a figure while its data is loading or could not be read —
// never a made-up zero.
const NOT_LOADED = "—";

/**
 * What each rider status change means, said in the confirmation before it is
 * made. Account status decides whether the rider app lets them in.
 */
const STATUS_ACTIONS = {
  approve: {
    title: "Approve rider application?",
    consequence:
      "They will be able to sign in to the VaxTrack rider app and can be assigned deliveries.",
    confirmLabel: "Approve rider",
    busyLabel: "Approving…",
    tone: "primary",
    status: "approved",
    done: (name) => `${name} has been approved.`,
  },
  reactivate: {
    title: "Set rider available?",
    consequence: "They can sign in to the rider app again and can be assigned new deliveries.",
    confirmLabel: "Set available",
    busyLabel: "Saving…",
    tone: "primary",
    status: "approved",
    done: (name) => `${name} set to standby.`,
  },
  offDuty: {
    title: "Mark rider off duty?",
    consequence:
      "They won't be able to use the rider app or receive new assignments until set available again. Orders already assigned to them stay assigned — reassign them from Assign Rider if needed.",
    confirmLabel: "Mark off duty",
    busyLabel: "Saving…",
    tone: "danger",
    status: "disabled",
    done: (name) => `${name} marked as off duty.`,
  },
  reject: {
    title: "Reject rider application?",
    consequence:
      "The application will be declined and they won't be able to sign in. This is final in the normal workflow.",
    confirmLabel: "Reject application",
    busyLabel: "Rejecting…",
    tone: "danger",
    status: "rejected",
    done: (name) => `${name} has been rejected.`,
  },
};

function Riders() {

  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedRider, setSelectedRider] = useState(null);
  const { toast, showToast, dismissToast } = useToast();
  // The status change awaiting confirmation: { rider, action } | null.
  const [pendingChange, setPendingChange] = useState(null);

  useEffect(() => {
    const unsubscribe = subscribeRiders(
      (raw) => {
        setRiders(raw.map(normalizeRider));
        setLoading(false);
        setLoadError("");
      },
      (error) => {
        setLoading(false);
        setLoadError(liveErrorMessage(error, "riders"));
      }
    );
    return () => unsubscribe();
  }, []);

  // Delivery figures, trip state and location — read-only. Until a feed has
  // answered (or if it fails) its figures show "—" and a note says why.
  const [orders, setOrders] = useState(null);
  const [tripStates, setTripStates] = useState(null);
  const [locations, setLocations] = useState(null);
  const [activityError, setActivityError] = useState("");
  const nowMs = useMinuteClock();
  useEffect(() => {
    const fail = (what) => (error) => {
      logSafeError(`Riders ${what}`, error);
      setActivityError(liveErrorMessage(error, what));
    };
    const unsubs = [
      subscribeDeliveries(setOrders, fail("delivery figures")),
      subscribeRiderDispatchStates(setTripStates, fail("trip status")),
      subscribeAllRiderLocations(setLocations, fail("rider locations")),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const activityByUid = useMemo(() => {
    const byRider = ordersByRider(orders || []);
    const map = new Map();
    for (const rider of riders) {
      map.set(rider.uid, riderActivity({
        rider,
        orders: byRider.get(rider.uid) || [],
        tripState: tripStates?.get(rider.uid),
        location: locations?.[rider.uid],
        nowMs,
      }));
    }
    return map;
  }, [riders, orders, tripStates, locations, nowMs]);
  const ordersReady = orders !== null;
  const fleet = useMemo(() => fleetOnTime(orders || []), [orders]);

  // What the row and the dialog show for a Rider's trip / account state.
  const assignmentOf = (rider) => {
    const trip = activityByUid.get(rider.uid)?.trip;
    if (!trip) return rider.statusText;
    return tripStates === null ? NOT_LOADED : trip.label;
  };

  // A status change is asked first, in a dialog that names the rider and the
  // consequence. The write runs from that dialog: one request however often
  // Confirm is pressed, success only after the write, and on failure the
  // dialog stays open with the reason.
  const requestStatusChange = (rider, action) => {
    setSelectedRider(null);
    setPendingChange({ rider, action });
  };
  const confirmStatusChange = async () => {
    const { rider, action } = pendingChange;
    const meta = STATUS_ACTIONS[action];
    try {
      await updateRiderStatus(rider.uid, meta.status);
    } catch (error) {
      logSafeError("Update rider status", error);
      throw error;
    }
    setPendingChange(null);
    showToast(meta.done(rider.name), "success");
  };
  const pendingMeta = pendingChange ? STATUS_ACTIONS[pendingChange.action] : null;
  const kpiState = { loading, error: loadError };

  const filteredRiders = useMemo(() => {
    return riders.filter((rider) => {
      const searchValue =
        `${rider.name} ${rider.displayId} ${rider.vehicle} ${rider.statusText}`.toLowerCase();
      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || rider.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [riders, searchTerm, statusFilter]);

  // At the hub = approved AND the server trip state says back at the hub.
  // A Rider whose trip state is not confirmed yet is not counted as available.
  const atHubCount = riders.filter(
    (r) => r.status === "standby" && activityByUid.get(r.uid)?.trip?.key === "available"
  ).length;
  const offDutyCount = riders.filter((r) => r.status === "offduty").length;

  return (
    <>
    <main className="riders-v2-page">
        <ToastRegion toast={toast} onDismiss={dismissToast} />

        <header className="riders-v2-header">
          <div>
            <p>Monitor field personnel and cold-chain assignments.</p>
            {/* Admin does not create rider accounts — riders self-register in
                the Flutter app and arrive here as pending for approval. Saying
                so avoids the page implying a capability it does not have. */}
            <p className="riders-onboarding-note">
              Riders register through the VaxTrack mobile app. New accounts
              appear here for approval.
            </p>
          </div>

          <div className="riders-v2-header-actions">
            <div className="riders-v2-search">
              <Search size={15} />
              <input
                placeholder="Search riders..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="riders-icon-btn"
              aria-label="How to view a rider's details"
              onClick={() =>
                showToast("Tip: select any rider row to view their details and account actions.", "info")
              }
            >
              <CircleHelp size={15} />
            </button>
          </div>
        </header>

        <section className="riders-summary-grid">
          <KpiCard
            label="Total riders"
            value={kpiValue(riders.length, kpiState)}
            context="Registered rider accounts"
            tone="neutral"
            onClick={() => setStatusFilter("all")}
          />

          <KpiCard
            label="At the hub"
            value={tripStates === null || activityError ? NOT_LOADED : kpiValue(atHubCount, kpiState)}
            context="Approved riders ready for a new trip"
            tone="success"
          />

          <KpiCard
            label="Off duty / pending"
            value={kpiValue(offDutyCount, kpiState)}
            context="Not currently available"
            tone="warning"
            onClick={() => setStatusFilter("offduty")}
          />

          <KpiCard
            label="On-time rate"
            value={ordersReady && !activityError ? formatRate(fleet.rate) : NOT_LOADED}
            context={
              !ordersReady || activityError
                ? "Delivery figures not loaded"
                : fleet.measured
                  ? `${fleet.onTime} of ${fleet.measured} measured deliveries on or before the requested date`
                  : "No measured deliveries yet"
            }
            tone="neutral"
          />
        </section>

        <section className="riders-filter-row">
          <button
            type="button"
            className={statusFilter === "all" ? "active" : ""}
            onClick={() => setStatusFilter("all")}
          >
            All
          </button>

          <button
            type="button"
            className={statusFilter === "standby" ? "active" : ""}
            onClick={() => setStatusFilter("standby")}
          >
            Active
          </button>

          <button
            type="button"
            className={statusFilter === "offduty" ? "active" : ""}
            onClick={() => setStatusFilter("offduty")}
          >
            Off Duty / Pending
          </button>
        </section>

        <section className="riders-personnel-card">
          <div className="riders-personnel-head">
            <div>
              <h2>Rider accounts</h2>
              <p>
                Showing {filteredRiders.length} of {riders.length} riders.
              </p>
            </div>
          </div>

          {activityError && (
            <p className="riders-activity-note" role="status">
              {activityError} Trip, delivery and location figures show “—” until they load.
            </p>
          )}

          <div className="riders-list">
            {filteredRiders.map((rider) => (
              <RiderRow
                key={rider.uid}
                rider={rider}
                activity={activityByUid.get(rider.uid)}
                assignment={assignmentOf(rider)}
                figuresReady={ordersReady && !activityError}
                locationReady={locations !== null && !activityError}
                onSelect={setSelectedRider}
              />
            ))}

            {loading && (
              <div className="riders-empty">
                <Users size={28} />
                <strong>Loading riders...</strong>
              </div>
            )}

            {!loading && loadError && (
              <div className="riders-empty">
                <Users size={28} />
                <strong>Could not load riders</strong>
                <p>{loadError}</p>
              </div>
            )}

            {!loading && !loadError && filteredRiders.length === 0 && (
              <div className="riders-empty">
                <Users size={28} />
                <strong>
                  {riders.length === 0
                    ? "No rider accounts found"
                    : "No riders match your filter"}
                </strong>
                <p>
                  {riders.length === 0
                    ? "Rider accounts are registered via the VaxTrack mobile app."
                    : "Try changing the search keyword or selected status filter."}
                </p>
              </div>
            )}
          </div>
        </section>
      </main>

      {selectedRider && (
        <RiderDetailsModal
          rider={selectedRider}
          details={(() => {
            const a = activityByUid.get(selectedRider.uid);
            const ready = ordersReady && !activityError;
            return {
              assignment: assignmentOf(selectedRider),
              currentOrders: !ready ? NOT_LOADED : a?.currentOrders.length ? a.currentOrders.join(", ") : "None",
              lastLocation: locations === null || activityError ? NOT_LOADED : a?.lastLocation,
              onTime: ready ? a?.onTimeText : NOT_LOADED,
            };
          })()}
          onClose={() => setSelectedRider(null)}
          onOffDuty={() => requestStatusChange(selectedRider, "offDuty")}
          onApprove={() => requestStatusChange(selectedRider, "approve")}
          onReactivate={() => requestStatusChange(selectedRider, "reactivate")}
          onReject={() => requestStatusChange(selectedRider, "reject")}
        />
      )}

      {pendingChange && pendingMeta && (
        <ConfirmDialog
          title={pendingMeta.title}
          target={`${pendingChange.rider.name}${
            pendingChange.rider.displayId ? ` · ${pendingChange.rider.displayId}` : ""
          }`}
          consequence={pendingMeta.consequence}
          confirmLabel={pendingMeta.confirmLabel}
          busyLabel={pendingMeta.busyLabel}
          tone={pendingMeta.tone}
          failureMessage={`${pendingChange.rider.name}'s status could not be changed. Nothing was saved — please try again.`}
          onConfirm={confirmStatusChange}
          onCancel={() => setPendingChange(null)}
        />
      )}

    </>
  );
}

/** One Rider in the personnel list. Figures read "—" until their data loads. */
function RiderRow({ rider, activity, assignment, figuresReady, locationReady, onSelect }) {
  return (
    <article
      className={`rider-row ${rider.status}`}
      onClick={() => onSelect(rider)}
    >
      <div className="rider-main-info">
        <div className={`rider-avatar ${rider.status}`}>
          {rider.initials}
        </div>

        <div>
          <h3>{rider.name}</h3>
          <p>
            {rider.vehicle} • ID: {rider.displayId}
          </p>
        </div>
      </div>

      <div className="rider-assignment-box">
        <strong>{rider.statusText}</strong>
        {activity?.trip && <p>{assignment}</p>}
        <small>
          Last location update:{" "}
          {locationReady ? activity?.lastLocation : NOT_LOADED}
        </small>
      </div>

      <div className="rider-performance">
        <span>Delivered today</span>
        <strong>{figuresReady ? activity?.deliveredToday ?? 0 : NOT_LOADED}</strong>
        <small>{figuresReady && activity?.deliveredToday === 1 ? "order" : "orders"}</small>
      </div>

      <div className="rider-performance">
        <span>On-time</span>
        <strong>{figuresReady ? formatRate(activity?.onTime.rate) : NOT_LOADED}</strong>
        <small>
          {!figuresReady
            ? "not loaded"
            : activity?.onTime.measured
              ? `${activity.onTime.onTime} of ${activity.onTime.measured}`
              : "not measured yet"}
        </small>
      </div>

      <div
        className="rider-actions"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={`rider-status-pill ${rider.status}`}>
          {rider.statusText}
        </span>

        <button
          type="button"
          onClick={() => onSelect(rider)}
        >
          Details
        </button>
      </div>
    </article>
  );
}

function RiderDetailsModal({
  rider,
  details,
  onClose,
  onOffDuty,
  onApprove,
  onReactivate,
  onReject,
}) {
  const isPending =
    rider.statusRaw === "pending" || rider.statusRaw === "pending_approval";
  const isApproved = rider.statusRaw === "approved";
  const isDisabled = rider.statusRaw === "disabled";
  // Focus moves in on open, Tab stays inside, Escape closes, and focus goes
  // back to the row that opened it.
  const dialogRef = useRef(null);
  useDialogFocus({ dialogRef, onDismiss: onClose });

  return (
    <div className="riders-modal-backdrop">
      <div
        className="riders-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rider-details-title"
      >
        <button type="button" className="riders-modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <div className={`riders-modal-avatar ${rider.status}`}>
          {rider.initials}
        </div>

        <h2 id="rider-details-title">{rider.name}</h2>
        <p>
          ID: {rider.displayId} • {rider.vehicle}
        </p>

        <div className="riders-modal-grid">
          <div>
            <span>Status</span>
            <strong>{rider.statusText}</strong>
          </div>

          <div>
            <span>Current orders</span>
            <strong>{details.currentOrders}</strong>
          </div>

          <div>
            <span>Trip</span>
            <strong>{details.assignment}</strong>
          </div>

          <div>
            <span>Last location update</span>
            <strong>{details.lastLocation}</strong>
          </div>

          <div>
            <span>Phone</span>
            <strong>{rider.phone}</strong>
          </div>

          <div>
            <span>On-time rate</span>
            <strong>{details.onTime}</strong>
          </div>

          <div>
            {/* No route-compliance figure is computed anywhere yet; the live
                deviation state is on Live Tracking. Said plainly, not "—". */}
            <span>Route compliance</span>
            <strong>Not measured yet</strong>
          </div>
        </div>

        <div className="riders-modal-actions">
          {/* Not built yet. Shown disabled, with the reason, rather than
              clickable with a toast that implies something happened. */}
          <button
            type="button"
            className="riders-light-action"
            disabled
            aria-describedby="rider-unavailable-actions"
          >
            View Route
          </button>

          <button
            type="button"
            className="riders-light-action"
            disabled
            aria-describedby="rider-unavailable-actions"
          >
            <PhoneCall size={15} aria-hidden="true" />
            Contact Rider
          </button>

          {isApproved && (
            <button
              type="button"
              className="riders-danger-action"
              onClick={onOffDuty}
            >
              Mark Off Duty
            </button>
          )}

          {isPending && (
            <button
              type="button"
              className="riders-primary-action"
              onClick={onApprove}
            >
              Approve
            </button>
          )}

          {isPending && (
            <button
              type="button"
              className="riders-danger-action"
              onClick={onReject}
            >
              Reject
            </button>
          )}

          {isDisabled && (
            <button
              type="button"
              className="riders-primary-action"
              onClick={onReactivate}
            >
              Set Available
            </button>
          )}
        </div>
        <p id="rider-unavailable-actions" className="riders-unavailable-note">
          Viewing a rider's route and calling them from VaxTrack aren't available yet. Use Live Tracking
          for positions and the rider's registered phone number to call.
        </p>

        {rider.uid && <RiderRecoveryPanel riderUid={rider.uid} riderName={rider.name} />}
      </div>
    </div>
  );
}

export default Riders;
