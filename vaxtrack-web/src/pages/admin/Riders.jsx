import { useEffect, useMemo, useState } from "react";
import {
  CircleHelp,
  PhoneCall,
  Search,
  Users,
  X,
} from "lucide-react";
import { subscribeRiders, updateRiderStatus } from "../../services/riderService";
import KpiCard from "../../components/ui/KpiCard";
import { kpiValue, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { ToastRegion } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/useToast";
import "./Riders.css";

const UI_STATUS_MAP = {
  approved: { uiStatus: "standby", statusText: "Standby" },
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
    assignment: mapped.uiStatus === "standby" ? "Available at Hub" : mapped.statusText,
    currentDelivery: "None",
    lastActive: "—",
    onTimeRate: "—",
    routeCompliance: "—",
    deliveriesToday: 0,
    location: raw.location || "—",
  };
}

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
        `${rider.name} ${rider.displayId} ${rider.vehicle} ${rider.statusText} ${rider.assignment}`.toLowerCase();
      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || rider.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [riders, searchTerm, statusFilter]);

  const standbyCount = riders.filter((r) => r.status === "standby").length;
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
            label="Standby"
            value={kpiValue(standbyCount, kpiState)}
            context="Available for assignment"
            tone="success"
            onClick={() => setStatusFilter("standby")}
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
            value="—"
            context="Delivery data not yet available"
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
            Standby
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
              <h2>Active Personnel</h2>
              <p>
                Showing {filteredRiders.length} of {riders.length} riders.
              </p>
            </div>
          </div>

          <div className="riders-list">
            {filteredRiders.map((rider) => (
              <article
                key={rider.uid}
                className={`rider-row ${rider.status}`}
                onClick={() => setSelectedRider(rider)}
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
                  <p>{rider.assignment}</p>
                  <small>Last active: {rider.lastActive}</small>
                </div>

                <div className="rider-performance">
                  <span>Today</span>
                  <strong>{rider.deliveriesToday}</strong>
                  <small>deliveries</small>
                </div>

                <div className="rider-performance">
                  <span>On-Time</span>
                  <strong>{rider.onTimeRate}</strong>
                  <small>rate</small>
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
                    onClick={() => setSelectedRider(rider)}
                  >
                    Details
                  </button>
                </div>
              </article>
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

function RiderDetailsModal({
  rider,
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

  return (
    <div className="riders-modal-backdrop">
      <div className="riders-modal">
        <button type="button" className="riders-modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <div className={`riders-modal-avatar ${rider.status}`}>
          {rider.initials}
        </div>

        <h2>{rider.name}</h2>
        <p>
          ID: {rider.displayId} • {rider.vehicle}
        </p>

        <div className="riders-modal-grid">
          <div>
            <span>Status</span>
            <strong>{rider.statusText}</strong>
          </div>

          <div>
            <span>Current Delivery</span>
            <strong>{rider.currentDelivery}</strong>
          </div>

          <div>
            <span>Current Assignment</span>
            <strong>{rider.assignment}</strong>
          </div>

          <div>
            <span>Location</span>
            <strong>{rider.location}</strong>
          </div>

          <div>
            <span>Phone</span>
            <strong>{rider.phone}</strong>
          </div>

          <div>
            <span>On-Time Rate</span>
            <strong>{rider.onTimeRate}</strong>
          </div>

          <div>
            <span>Route Compliance</span>
            <strong>{rider.routeCompliance}</strong>
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
      </div>
    </div>
  );
}

export default Riders;
