import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import {
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  Clock,
  Eye,
  Globe,
  LockKeyhole,
  MoreVertical,
  RefreshCcw,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  UserCheck,
  UserRound,
  Users,
  UserX,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { AdminSidebar } from "./Inventory";
import "./Settings.css";
import { subscribeUsers, updateUserStatus, updateUserRole } from "../../services/userService";

const defaultOrg = {
  organizationName: "VaxTrack Philippines",
  registrationId: "ORG-PH-2023-8842",
  primaryContact: "admin@vaxtrack.ph",
};

const defaultRegional = {
  timeZone: "Asia/Manila GMT+8",
  language: "English (US)",
  dateFormat: "DD/MM/YYYY",
};

const defaultFeatures = {
  inventoryAlerts: true,
  lowStockAlerts: true,
  expiryAlerts: true,
  routeDeviationAlerts: false,
  deliveryStatusNotifications: true,
};

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
            <h1>
              {activeTab === "general"
                ? "Admin Settings - Alert Configuration"
                : "User Management"}
            </h1>

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

function GeneralSettings({ searchTerm, showToast }) {
  const [org, setOrg] = useState(defaultOrg);
  const [regional, setRegional] = useState(defaultRegional);
  const [features, setFeatures] = useState(defaultFeatures);
  const [pendingDisable, setPendingDisable] = useState(null);

  const enabledCount = Object.values(features).filter(Boolean).length;
  const disabledCount = Object.values(features).length - enabledCount;

  const featureItems = [
    {
      key: "inventoryAlerts",
      title: "Enable inventory alerts",
      desc: "Receive notifications for warehouse movements.",
      preview: "Inventory warnings appear on Admin Dashboard and Alerts page.",
    },
    {
      key: "lowStockAlerts",
      title: "Enable low stock alerts",
      desc: "Notify when vaccine levels drop below threshold.",
      preview: "Low-stock batches will be highlighted in Inventory Monitoring.",
    },
    {
      key: "expiryAlerts",
      title: "Enable expired/near-expiry vaccine alerts",
      desc: "Warnings for stock reaching end-of-life.",
      preview: "Near-expiry warnings appear before batches reach unsafe dates.",
    },
    {
      key: "routeDeviationAlerts",
      title: "Enable route deviation alerts",
      desc: "Track real-time courier pathing anomalies.",
      preview: "Route deviation alerts appear on Dashboard, Alerts, and Dispatcher pages.",
      important: true,
    },
    {
      key: "deliveryStatusNotifications",
      title: "Enable delivery status notifications",
      desc: "Automatic updates on shipment progress.",
      preview: "Delivery updates notify admins when shipments are loading or in transit.",
    },
  ];

  const filteredFeatures = featureItems.filter((item) => {
    const searchValue = `${item.title} ${item.desc} ${item.preview}`.toLowerCase();
    return searchValue.includes(searchTerm.toLowerCase());
  });

  const handleFeatureToggle = (key) => {
    if (key === "routeDeviationAlerts" && features[key]) {
      setPendingDisable(key);
      return;
    }

    setFeatures((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleSave = () => {
    showToast("Settings saved successfully.");
  };

  const handleDiscard = () => {
    setOrg(defaultOrg);
    setRegional(defaultRegional);
    setFeatures(defaultFeatures);
    showToast("Changes discarded.");
  };

  const confirmDisableImportantAlert = () => {
    if (!pendingDisable) return;

    setFeatures((prev) => ({
      ...prev,
      [pendingDisable]: false,
    }));

    setPendingDisable(null);
    showToast("Route deviation alerts disabled.");
  };

  return (
    <>
      <section className="settings-summary-grid">
        <SettingsSummaryCard
          icon={<Bell size={19} />}
          value={enabledCount}
          label="Enabled Alerts"
          note="Currently active"
          type="blue"
        />

        <SettingsSummaryCard
          icon={<AlertTriangle size={19} />}
          value={disabledCount}
          label="Disabled Alerts"
          note="Needs review if critical"
          type="red"
        />

        <SettingsSummaryCard
          icon={<Globe size={19} />}
          value="GMT+8"
          label="Timezone"
          note="Asia/Manila"
          type="green"
        />

        <SettingsSummaryCard
          icon={<ShieldCheck size={19} />}
          value="Active"
          label="Admin Profile"
          note="System configuration"
          type="amber"
        />
      </section>

      <section className="settings-v3-grid">
        <div className="settings-v3-left">
          <div className="settings-v3-card">
            <div className="settings-card-title">
              <Building2 size={17} />
              <h2>Organization Profile</h2>
            </div>

            <div className="settings-form-grid">
              <label>
                Organization Name
                <input
                  value={org.organizationName}
                  onChange={(e) =>
                    setOrg((prev) => ({
                      ...prev,
                      organizationName: e.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Registration ID
                <input
                  value={org.registrationId}
                  onChange={(e) =>
                    setOrg((prev) => ({
                      ...prev,
                      registrationId: e.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Primary Contact
                <input
                  value={org.primaryContact}
                  onChange={(e) =>
                    setOrg((prev) => ({
                      ...prev,
                      primaryContact: e.target.value,
                    }))
                  }
                />
              </label>
            </div>
          </div>

          <div className="settings-v3-card">
            <div className="settings-card-title">
              <Globe size={17} />
              <h2>Regional Settings</h2>
            </div>

            <div className="settings-form-grid three">
              <label>
                Time Zone
                <select
                  value={regional.timeZone}
                  onChange={(e) =>
                    setRegional((prev) => ({
                      ...prev,
                      timeZone: e.target.value,
                    }))
                  }
                >
                  <option>Asia/Manila GMT+8</option>
                  <option>Asia/Singapore GMT+8</option>
                  <option>UTC</option>
                </select>
              </label>

              <label>
                Language
                <select
                  value={regional.language}
                  onChange={(e) =>
                    setRegional((prev) => ({
                      ...prev,
                      language: e.target.value,
                    }))
                  }
                >
                  <option>English (US)</option>
                  <option>Filipino</option>
                </select>
              </label>

              <label>
                Date Format
                <select
                  value={regional.dateFormat}
                  onChange={(e) =>
                    setRegional((prev) => ({
                      ...prev,
                      dateFormat: e.target.value,
                    }))
                  }
                >
                  <option>DD/MM/YYYY</option>
                  <option>MM/DD/YYYY</option>
                  <option>YYYY-MM-DD</option>
                </select>
              </label>
            </div>
          </div>

          <div className="settings-v3-card preview-card">
            <div className="settings-card-title">
              <Eye size={17} />
              <h2>Notification Preview</h2>
            </div>

            <p>
              Enabled alerts will appear in the Admin Dashboard, Alerts page, and
              related role dashboards. Critical alerts such as route deviation should
              stay enabled during live delivery monitoring.
            </p>
          </div>

          <div className="settings-action-row">
            <button type="button" className="discard-btn" onClick={handleDiscard}>
              <RefreshCcw size={14} />
              Discard Changes
            </button>

            <button type="button" className="save-settings-btn" onClick={handleSave}>
              <Save size={14} />
              Save Settings
            </button>
          </div>
        </div>

        <aside className="settings-v3-card system-card">
          <div className="settings-card-title">
            <SettingsIcon size={17} />
            <h2>System Features</h2>
          </div>

          <div className="feature-list">
            {filteredFeatures.map((item) => (
              <FeatureToggle
                key={item.key}
                title={item.title}
                desc={item.desc}
                enabled={features[item.key]}
                important={item.important}
                onToggle={() => handleFeatureToggle(item.key)}
              />
            ))}

            {filteredFeatures.length === 0 && (
              <div className="settings-empty">
                <SettingsIcon size={24} />
                <strong>No settings found</strong>
                <p>Try another search keyword.</p>
              </div>
            )}
          </div>
        </aside>
      </section>

      {pendingDisable && (
        <ConfirmModal
          title="Disable route deviation alerts?"
          message="This may prevent admins from receiving rider route warnings. This alert is important for geofence and delivery route monitoring."
          confirmLabel="Disable Alert"
          onCancel={() => setPendingDisable(null)}
          onConfirm={confirmDisableImportantAlert}
        />
      )}
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
  const [actionMenuEmail, setActionMenuEmail] = useState(null);
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
      setActionMenuEmail(null);
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
      setActionMenuEmail(null);
    }
  };

  const roles = Array.from(new Set(staff.map((person) => person.role)));
  const departments = Array.from(new Set(staff.map((person) => person.department)));
  const branches = Array.from(new Set(staff.map((person) => person.branch)));

  return (
    <>
      <section className="settings-summary-grid">
        <SettingsSummaryCard
          icon={<Users size={19} />}
          value={totalStaff}
          label="Total Staff"
          note="Registered personnel"
          type="blue"
        />

        <SettingsSummaryCard
          icon={<UserCheck size={19} />}
          value={activeCount}
          label="Active"
          note="Approved accounts"
          type="green"
        />

        <SettingsSummaryCard
          icon={<Clock size={19} />}
          value={pendingCount}
          label="Pending"
          note="Needs approval"
          type="amber"
        />

        <SettingsSummaryCard
          icon={<UserX size={19} />}
          value={inactiveCount}
          label="Inactive"
          note="Disabled accounts"
          type="red"
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
                <tr key={person.email} onClick={() => setSelectedStaff(person)}>
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
                          setActionMenuEmail((prev) =>
                            prev === person.email ? null : person.email
                          )
                        }
                      >
                        <MoreVertical size={16} />
                      </button>

                      {actionMenuEmail === person.email && (
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
                                setActionMenuEmail(null);
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

function SettingsSummaryCard({ icon, value, label, note, type }) {
  return (
    <div className={`settings-summary-card ${type}`}>
      <div className="settings-summary-icon">{icon}</div>

      <div>
        <h2>{value}</h2>
        <p>{label}</p>
        <small>{note}</small>
      </div>
    </div>
  );
}

function FeatureToggle({ title, desc, enabled, important, onToggle }) {
  return (
    <div className={`feature-toggle-row ${important ? "important" : ""}`}>
      <div>
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>

      <button
        type="button"
        className={`settings-toggle ${enabled ? "enabled" : ""}`}
        onClick={onToggle}
        aria-label={title}
      >
        <span></span>
      </button>
    </div>
  );
}

function StaffDetailsModal({ person, isSelf, onClose, onApprove, onDeactivate, onReactivate, onChangeRole }) {
  return (
    <div className="settings-modal-backdrop">
      <div className="settings-modal">
        <button type="button" className="settings-modal-close" onClick={onClose}>
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
        <button type="button" className="settings-modal-close" onClick={onClose}>
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

function ConfirmModal({ title, message, confirmLabel, onCancel, onConfirm }) {
  return (
    <div className="settings-modal-backdrop">
      <div className="settings-modal confirm-modal">
        <button type="button" className="settings-modal-close" onClick={onCancel}>
          <X size={18} />
        </button>

        <div className="settings-modal-avatar warning">
          <AlertTriangle size={28} />
        </div>

        <h2>{title}</h2>
        <p>{message}</p>

        <div className="settings-modal-actions">
          <button type="button" className="settings-danger-action" onClick={onConfirm}>
            {confirmLabel}
          </button>

          <button type="button" className="settings-light-action" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default Settings;