import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  Bell,
  Building2,
  Globe,
  Clock,
  MoreVertical,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "../../components/admin/AdminSidebar";
import KpiCard from "../../components/ui/KpiCard";
import "./Settings.css";
import { subscribeUsers, updateUserStatus, updateUserRole } from "../../services/userService";
// The invoice issuer is a constant in the invoice model, not a stored setting.
import { COMPANY_NAME } from "../../services/invoiceModel";

const ROLE_DISPLAY = {
  admin: "Admin",
  dispatcher: "Dispatcher",
  salesrep: "Sales Representative",
  rider: "Rider",
};

const ASSIGNABLE_ROLES = [
  { value: "salesrep", label: "Sales Representative" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "rider", label: "Rider" },
];

const UI_STATUS = {
  approved: { status: "active", statusLabel: "Active" },
  pending: { status: "pending", statusLabel: "Pending" },
  pending_approval: { status: "pending", statusLabel: "Pending" },
  rejected: { status: "inactive", statusLabel: "Inactive" },
  disabled: { status: "inactive", statusLabel: "Inactive" },
};

function normalizeUser(raw) {
  const uiStatus = UI_STATUS[raw.status] || { status: "pending", statusLabel: "Pending" };
  return {
    uid: raw.id,
    id: raw.employeeId || "—",
    name: raw.name || raw.fullName || "—",
    email: raw.email || "—",
    rawRole: raw.role || "",
    role: ROLE_DISPLAY[raw.role] || raw.role || "Unassigned",
    department: raw.department || "—",
    branch: raw.branch || "—",
    status: uiStatus.status,
    statusLabel: uiStatus.statusLabel,
    lastLogin: "—",
  };
}

const pageSize = 4;

function Settings() {
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState("general");
  const [searchTerm, setSearchTerm] = useState("");
  const [toast, setToast] = useState("");

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
  };

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="settings" onLogout={handleLogout} />

      <main className="settings-v3-main">
        {toast && <div className="settings-toast">{toast}</div>}

        <header className="settings-v3-header">
          <div>
            <h1>Settings</h1>

            <p>
              {activeTab === "general"
                ? "Manage organization details and system-wide logistics rules."
                : "Manage personnel, permissions, branches, and registration requests."}
            </p>
          </div>

          <div className="settings-v3-actions">
            <div className="settings-v3-search">
              <Search size={15} />
              <input
                placeholder={
                  activeTab === "general"
                    ? "Search settings or ID..."
                    : "Search employee, role, email..."
                }
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => showToast("No new settings notifications.")}
            >
              <Bell size={15} />
              <span></span>
            </button>

            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => showToast("Last settings update: Today, 6:18 PM.")}
            >
              <Clock size={15} />
            </button>

            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => showToast("Security settings are active.")}
            >
              <ShieldCheck size={15} />
            </button>
          </div>
        </header>

        <div className="settings-tabs">
          <button
            type="button"
            className={activeTab === "general" ? "active" : ""}
            onClick={() => setActiveTab("general")}
          >
            General
          </button>

          <button
            type="button"
            className={activeTab === "users" ? "active" : ""}
            onClick={() => setActiveTab("users")}
          >
            User Management
          </button>
        </div>

        {activeTab === "general" ? (
          <GeneralSettings searchTerm={searchTerm} showToast={showToast} />
        ) : (
          <UserManagement searchTerm={searchTerm} showToast={showToast} />
        )}
      </main>
    </div>
  );
}

/**
 * The General tab — entirely read-only.
 *
 * It previously held eleven editable fields across Organization Profile,
 * Regional Settings and System Features, with Save and Discard buttons. A trace
 * of every field found NO consumer anywhere in the application, and there was
 * no settingsService and no `settings` collection to save into: "Save Settings"
 * showed "Settings saved successfully." and wrote nothing.
 *
 * Nothing was persisted to fix it. Storing `lowStockAlerts: true` where no
 * reader exists is the same false claim relocated into Firestore, and it would
 * then need rules, an audit trail and a migration to maintain a value that
 * changes nothing. The tab now reports the configuration the system actually
 * has, with each value's real source named.
 */
function GeneralSettings() {
  // What the app genuinely renders: en-US short month, e.g. "Sep 8, 2026".
  // Derived rather than written out, so it cannot drift from the real
  // formatting the way the old hardcoded "DD/MM/YYYY" label did.
  const sampleDateDisplay = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <section className="settings-summary-grid">
        <KpiCard
          label="Time zone"
          value="UTC+8"
          context="Asia/Manila — enforced in code"
          tone="neutral"
        />

        <KpiCard
          label="Date display"
          value={sampleDateDisplay}
          context="en-US, used throughout"
          tone="neutral"
        />

        <KpiCard
          label="Alert delivery"
          value="In-app"
          context="Push and email not configured"
          tone="info"
        />

        <KpiCard
          label="Organization record"
          value="None"
          context="Invoice issuer is fixed in code"
          tone="neutral"
        />
      </section>


      {/* READ-ONLY. Every control here used to be editable with a "Save
          Settings" button that reported success and wrote nothing: no
          settingsService existed, no `settings` collection existed, and a trace
          of all eleven fields found ZERO consumers anywhere in the app.

          Persisting them to make the button work was rejected — a stored
          `lowStockAlerts: true` that nothing reads is the same false promise,
          moved into the database. What is shown instead is what the system
          actually does, and where each value really comes from. */}
      <section className="settings-v3-grid settings-v3-grid--readonly">
        <div className="settings-v3-left">
          <div className="settings-v3-card">
            <div className="settings-card-title">
              <Building2 size={17} />
              <h2>Organization</h2>
            </div>

            <p className="settings-readonly-lede">
              VaxTrack stores no organization record. These values are fixed in
              the application, not configured here.
            </p>

            <dl className="settings-fact-list">
              <div>
                <dt>Invoice issuer</dt>
                <dd>
                  <strong>{COMPANY_NAME}</strong>
                  <span>
                    Fixed in code. Printed on every invoice as the issuing
                    company.
                  </span>
                </dd>
              </div>
              <div>
                <dt>Company address, contact and TIN</dt>
                <dd>
                  <strong>Entered per invoice</strong>
                  <span>
                    Typed on each invoice in the Invoice Editor and stored on
                    that invoice — there is no shared company record to edit.
                  </span>
                </dd>
              </div>
            </dl>
          </div>

          <div className="settings-v3-card">
            <div className="settings-card-title">
              <Globe size={17} />
              <h2>Regional</h2>
            </div>

            <p className="settings-readonly-lede">
              Fixed configuration. The time zone below is enforced in code on
              both the client and the server; the others are not configurable.
            </p>

            <dl className="settings-fact-list">
              <div>
                <dt>Time zone</dt>
                <dd>
                  <strong>Asia/Manila (UTC+8)</strong>
                  <span>
                    Real and load-bearing: batch expiry uses a date-only Manila
                    cutoff, so stock stays usable through the whole of its
                    expiry date locally.
                  </span>
                </dd>
              </div>
              <div>
                <dt>Date display</dt>
                <dd>
                  <strong>{sampleDateDisplay}</strong>
                  <span>
                    en-US short-month format, used on every date the
                    application renders.
                  </span>
                </dd>
              </div>
              <div>
                <dt>Language</dt>
                <dd>
                  <strong>English (US)</strong>
                  <span>
                    The interface is English-only. No translation layer exists,
                    so there is no alternative to choose.
                  </span>
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <aside className="settings-v3-card system-card">
          <div className="settings-card-title">
            <SettingsIcon size={17} />
            <h2>Alert delivery</h2>
          </div>

          {/* The System Features toggles are gone. Five switches — inventory,
              low-stock, expiry, route-deviation and delivery-status alerts —
              had no executable reader: alerts are written to Firestore by the
              services and rendered from that collection regardless of any
              toggle. One even opened a confirmation dialog warning that
              disabling it "may prevent admins from receiving rider route
              warnings", which it could not do. */}
          <p className="settings-readonly-lede">
            Alerts cannot be switched off. Every alert written to Firestore is
            shown to admins and dispatchers.
          </p>

          <dl className="settings-fact-list">
            <div>
              <dt>In-app alerts</dt>
              <dd>
                <strong>Always on</strong>
                <span>
                  Read live on the Alerts page and the dashboard.
                </span>
              </dd>
            </div>
            <div>
              <dt>Push and email</dt>
              <dd>
                <strong>Not configured</strong>
                <span>
                  No messaging or email channel exists, so alerts do not leave
                  the dashboard.
                </span>
              </dd>
            </div>
          </dl>
        </aside>
      </section>

    </>
  );
}

function UserManagement({ searchTerm, showToast }) {
  const [staff, setStaff] = useState([]);
  const [roleFilter, setRoleFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedStaff, setSelectedStaff] = useState(null);
  // Tracked by UID, not email. `normalizeUser` falls back to "—" when a user
  // has no email, so two such rows shared a key AND opened each other's action
  // menu — an admin could act on a menu belonging to a different person than
  // the row they clicked. The writes themselves already used person.uid.
  const [actionMenuUid, setActionMenuUid] = useState(null);
  const [roleChangeTarget, setRoleChangeTarget] = useState(null);

  useEffect(() => {
    const unsubscribe = subscribeUsers((raw) => {
      setStaff(raw.map(normalizeUser));
    });
    return () => unsubscribe();
  }, []);

  const filteredStaff = useMemo(() => {
    return staff.filter((person) => {
      const searchValue =
        `${person.name} ${person.email} ${person.role} ${person.department} ${person.branch} ${person.statusLabel}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesRole = roleFilter === "all" || person.role === roleFilter;
      const matchesDepartment =
        departmentFilter === "all" || person.department === departmentFilter;
      const matchesBranch = branchFilter === "all" || person.branch === branchFilter;

      return matchesSearch && matchesRole && matchesDepartment && matchesBranch;
    });
  }, [staff, searchTerm, roleFilter, departmentFilter, branchFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredStaff.length / pageSize));

  const paginatedStaff = filteredStaff.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const startItem =
    filteredStaff.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;

  const endItem = Math.min(currentPage * pageSize, filteredStaff.length);

  const totalStaff = staff.length;
  const activeCount = staff.filter((person) => person.status === "active").length;
  const pendingCount = staff.filter((person) => person.status === "pending").length;
  const inactiveCount = staff.filter((person) => person.status === "inactive").length;

  const updateStatus = async (uid, firestoreStatus) => {
    try {
      await updateUserStatus(uid, firestoreStatus);
      const label = UI_STATUS[firestoreStatus]?.statusLabel || firestoreStatus;
      showToast(`User status updated to ${label}.`);
    } catch {
      showToast("Failed to update user status. Please try again.");
    } finally {
      setActionMenuUid(null);
    }
  };

  const currentAdminUid = auth.currentUser?.uid;

  const changeRole = async (uid, newRole) => {
    if (uid === currentAdminUid) {
      showToast("You cannot change your own role.");
      setRoleChangeTarget(null);
      return;
    }
    try {
      await updateUserRole(uid, newRole);
      showToast(`User role updated to ${ROLE_DISPLAY[newRole] || newRole}.`);
    } catch {
      showToast("Failed to update user role. Please try again.");
    } finally {
      setRoleChangeTarget(null);
      setActionMenuUid(null);
    }
  };

  const roles = Array.from(new Set(staff.map((person) => person.role)));
  const departments = Array.from(new Set(staff.map((person) => person.department)));
  const branches = Array.from(new Set(staff.map((person) => person.branch)));

  return (
    <>
      <section className="settings-summary-grid">
        <KpiCard
          label="Total staff"
          value={totalStaff}
          context="Registered personnel"
          tone="neutral"
        />

        <KpiCard
          label="Active"
          value={activeCount}
          context="Approved accounts"
          tone="success"
        />

        <KpiCard
          label="Pending"
          value={pendingCount}
          context="Needs approval"
          tone="warning"
        />

        <KpiCard
          label="Inactive"
          value={inactiveCount}
          context="Disabled accounts"
          tone="danger"
        />
      </section>

      <section className="user-management-card">
        <div className="staff-card-header">
          <div className="settings-card-title">
            <Users size={17} />
            <h2>Staff Directory</h2>
          </div>

          <div className="staff-actions">
            <select
              value={departmentFilter}
              onChange={(e) => {
                setDepartmentFilter(e.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="all">All Departments</option>
              {departments.map((department) => (
                <option key={department} value={department}>
                  {department}
                </option>
              ))}
            </select>

            <select
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="all">All Roles</option>
              {roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>

            <select
              value={branchFilter}
              onChange={(e) => {
                setBranchFilter(e.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="all">All Branches</option>
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="staff-table-wrap">
          <table className="staff-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Role</th>
                <th>Department</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {paginatedStaff.map((person) => (
                <tr key={person.uid} onClick={() => setSelectedStaff(person)}>
                  <td>
                    <div className="staff-profile">
                      <div className={`staff-avatar ${person.status}`}>
                        <UserRound size={16} />
                      </div>

                      <div>
                        <strong>{person.name}</strong>
                        <small>{person.email}</small>
                      </div>
                    </div>
                  </td>

                  <td>{person.role}</td>
                  <td>{person.department}</td>
                  <td>{person.branch}</td>

                  <td>
                    <span className={`staff-status ${person.status}`}>
                      {person.statusLabel}
                    </span>
                  </td>

                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="staff-action-menu-wrap">
                      <button
                        type="button"
                        className="table-action-btn"
                        onClick={() =>
                          setActionMenuUid((prev) =>
                            prev === person.uid ? null : person.uid
                          )
                        }
                      >
                        <MoreVertical size={16} />
                      </button>

                      {actionMenuUid === person.uid && (
                        <div className="staff-action-menu">
                          <button type="button" onClick={() => setSelectedStaff(person)}>
                            View Profile
                          </button>

                          {person.status === "pending" && (
                            <>
                              <button
                                type="button"
                                onClick={() => updateStatus(person.uid, "approved")}
                              >
                                Approve
                              </button>

                              <button
                                type="button"
                                className="danger"
                                onClick={() => updateStatus(person.uid, "rejected")}
                              >
                                Reject
                              </button>
                            </>
                          )}

                          {person.status === "active" && (
                            <button
                              type="button"
                              className="danger"
                              onClick={() => updateStatus(person.uid, "disabled")}
                            >
                              Deactivate
                            </button>
                          )}

                          {person.status === "inactive" && (
                            <button
                              type="button"
                              onClick={() => updateStatus(person.uid, "approved")}
                            >
                              Reactivate
                            </button>
                          )}

                          {person.uid !== currentAdminUid && (
                            <button
                              type="button"
                              onClick={() => {
                                setRoleChangeTarget(person);
                                setActionMenuUid(null);
                              }}
                            >
                              Change Role
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredStaff.length === 0 && (
            <div className="settings-empty">
              <Users size={24} />
              <strong>No staff found</strong>
              <p>Try changing the search keyword or selected filters.</p>
            </div>
          )}
        </div>

        <div className="staff-pagination">
          <p>
            Showing {startItem}–{endItem} of {filteredStaff.length} employees
          </p>

          <div>
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
            >
              Previous
            </button>

            {Array.from({ length: totalPages }, (_, index) => index + 1).map(
              (page) => (
                <button
                  key={page}
                  type="button"
                  className={currentPage === page ? "active" : ""}
                  onClick={() => setCurrentPage(page)}
                >
                  {page}
                </button>
              )
            )}

            <button
              type="button"
              disabled={currentPage === totalPages}
              onClick={() =>
                setCurrentPage((prev) => Math.min(prev + 1, totalPages))
              }
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {selectedStaff && (
        <StaffDetailsModal
          person={selectedStaff}
          isSelf={selectedStaff.uid === currentAdminUid}
          onClose={() => setSelectedStaff(null)}
          onApprove={() => {
            updateStatus(selectedStaff.uid, "approved");
            setSelectedStaff(null);
          }}
          onDeactivate={() => {
            updateStatus(selectedStaff.uid, "disabled");
            setSelectedStaff(null);
          }}
          onReactivate={() => {
            updateStatus(selectedStaff.uid, "approved");
            setSelectedStaff(null);
          }}
          onChangeRole={() => {
            setSelectedStaff(null);
            setRoleChangeTarget(selectedStaff);
          }}
        />
      )}

      {roleChangeTarget && (
        <RoleChangeModal
          person={roleChangeTarget}
          onClose={() => setRoleChangeTarget(null)}
          onConfirm={(newRole) => changeRole(roleChangeTarget.uid, newRole)}
        />
      )}
    </>
  );
}

function StaffDetailsModal({ person, isSelf, onClose, onApprove, onDeactivate, onReactivate, onChangeRole }) {
  return (
    <div className="settings-modal-backdrop">
      <div className="settings-modal">
        <button type="button" className="settings-modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <div className={`settings-modal-avatar ${person.status}`}>
          <UserRound size={28} />
        </div>

        <h2>{person.name}</h2>
        <p>
          {person.role} • {person.id}
        </p>

        <div className="settings-modal-grid">
          <div>
            <span>Email</span>
            <strong>{person.email}</strong>
          </div>

          <div>
            <span>Status</span>
            <strong>{person.statusLabel}</strong>
          </div>

          <div>
            <span>Department</span>
            <strong>{person.department}</strong>
          </div>

          <div>
            <span>Branch</span>
            <strong>{person.branch}</strong>
          </div>

          <div>
            <span>Last Login</span>
            <strong>{person.lastLogin}</strong>
          </div>

          <div>
            <span>Access Level</span>
            <strong>{person.role}</strong>
          </div>
        </div>

        <div className="settings-modal-actions">
          {person.status === "pending" && (
            <button type="button" className="settings-primary-action" onClick={onApprove}>
              Approve User
            </button>
          )}

          {person.status === "active" && (
            <button
              type="button"
              className="settings-danger-action"
              onClick={onDeactivate}
            >
              Deactivate
            </button>
          )}

          {person.status === "inactive" && (
            <button
              type="button"
              className="settings-primary-action"
              onClick={onReactivate}
            >
              Reactivate
            </button>
          )}

          {!isSelf && (
            <button type="button" className="settings-primary-action" onClick={onChangeRole}>
              Change Role
            </button>
          )}

          <button type="button" className="settings-light-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleChangeModal({ person, onClose, onConfirm }) {
  const [newRole, setNewRole] = useState(person.rawRole || "salesrep");

  return (
    <div className="settings-modal-backdrop">
      <div className="settings-modal confirm-modal">
        <button type="button" className="settings-modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <div className="settings-modal-avatar">
          <UserRound size={28} />
        </div>

        <h2>Change Role</h2>
        <p>
          Update role for <strong>{person.name}</strong> ({person.email}).
          Current role: <strong>{person.role}</strong>.
        </p>

        <div className="role-change-select-wrap">
          <label>New Role</label>
          <select
            className="role-change-select"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-modal-actions">
          <button
            type="button"
            className="settings-primary-action"
            disabled={newRole === person.rawRole}
            onClick={() => onConfirm(newRole)}
          >
            Confirm Role Change
          </button>

          <button type="button" className="settings-light-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default Settings;