import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mail,
  Phone,
  Save,
  Shield,
  User,
} from "lucide-react";
import { auth } from "../../firebase";
import { getUserProfile, updateUserProfile } from "../../services/userService";
import SalesRepLayout from "./SalesRepLayout";

function statusLabel(status) {
  if (status === "approved") return "Active";
  if (status === "pending" || status === "pending_approval") return "Pending Approval";
  if (status === "disabled") return "Inactive";
  if (status === "rejected") return "Rejected";
  return status || "—";
}

function roleLabel(role) {
  if (role === "salesrep") return "Sales Representative";
  if (role === "admin") return "Administrator";
  if (role === "dispatcher") return "Dispatcher";
  if (role === "rider") return "Rider";
  return role || "—";
}

function SalesRepSettings() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      setError("You must be logged in to view settings.");
      setLoading(false);
      return;
    }

    getUserProfile(user.uid)
      .then((data) => {
        if (!data) {
          setError("User profile not found in database.");
          setLoading(false);
          return;
        }
        setProfile(data);
        setName(data.name || data.fullName || data.displayName || "");
        setPhone(data.phone || data.contactNumber || "");
        setOrganization(data.organization || data.company || data.clinic || "");
        setLoading(false);
      })
      .catch((err) => {
        if (err?.code === "permission-denied") {
          setError("You do not have permission to view your profile.");
        } else {
          setError("Unable to load profile. Please try again later.");
        }
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    const user = auth.currentUser;
    if (!user) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setToast("Name cannot be empty.");
      return;
    }

    setSaving(true);
    setToast("");

    try {
      await updateUserProfile(user.uid, {
        name: trimmedName,
        phone: phone.trim(),
        contactNumber: phone.trim(),
        organization: organization.trim(),
      });

      setProfile((prev) => ({
        ...prev,
        name: trimmedName,
        phone: phone.trim(),
        contactNumber: phone.trim(),
        organization: organization.trim(),
      }));

      setToast("Profile updated successfully.");
    } catch (err) {
      setToast(err.message || "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  };

  const hasChanges =
    profile &&
    (name.trim() !== (profile.name || profile.fullName || profile.displayName || "") ||
      phone.trim() !== (profile.phone || profile.contactNumber || "") ||
      organization.trim() !== (profile.organization || profile.company || profile.clinic || ""));

  if (loading) {
    return (
      <SalesRepLayout active="settings" title="Settings" showSearch={false}>
        <div className="inventory-loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading profile...</p>
        </div>
      </SalesRepLayout>
    );
  }

  if (error) {
    return (
      <SalesRepLayout active="settings" title="Settings" showSearch={false}>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <p>{error}</p>
        </div>
      </SalesRepLayout>
    );
  }

  const authUser = auth.currentUser;

  return (
    <SalesRepLayout active="settings" title="Settings" showSearch={false}>
      <section className="settings-page-header">
        <h1>Account Settings</h1>
        <p>View and update your profile information.</p>
      </section>

      {toast && (
        <div className="alerts-v2-toast">
          <CheckCircle2 size={16} />
          <span>{toast}</span>
          <button type="button" onClick={() => setToast("")}>×</button>
        </div>
      )}

      <div className="settings-simple-grid">
        <div className="salesrep-card">
          <h2><User size={18} /> Profile Information</h2>

          <div className="settings-field">
            <label>Full Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
            />
          </div>

          <div className="settings-field">
            <label>Email Address</label>
            <input
              type="email"
              value={authUser?.email || profile?.email || ""}
              disabled
              className="settings-readonly"
            />
            <small className="settings-hint">Email cannot be changed here.</small>
          </div>

          <div className="settings-field">
            <label><Phone size={14} /> Phone / Contact Number</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="e.g. +63 917 123 4567"
            />
          </div>

          <div className="settings-field">
            <label>Organization / Clinic</label>
            <input
              type="text"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              placeholder="e.g. Manila Central Hub"
            />
          </div>

          <button
            type="button"
            className="settings-save-btn"
            onClick={handleSave}
            disabled={saving || !hasChanges}
          >
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>

        <div className="salesrep-card">
          <h2><Shield size={18} /> Account Details</h2>

          <div className="settings-detail-row">
            <span>Role</span>
            <strong>{roleLabel(profile?.role)}</strong>
          </div>

          <div className="settings-detail-row">
            <span>Account Status</span>
            <strong className={`settings-status ${profile?.status || ""}`}>
              {statusLabel(profile?.status)}
            </strong>
          </div>

          <div className="settings-detail-row">
            <span>Employee ID</span>
            <strong>{profile?.employeeId || "—"}</strong>
          </div>

          <div className="settings-detail-row">
            <span><Mail size={14} /> Email</span>
            <strong>{authUser?.email || profile?.email || "—"}</strong>
          </div>

          <div className="settings-detail-row">
            <span>UID</span>
            <strong className="settings-uid">{authUser?.uid || "—"}</strong>
          </div>

          <p className="settings-readonly-note">
            Role, status, and employee ID are managed by your administrator.
          </p>
        </div>
      </div>
    </SalesRepLayout>
  );
}

export default SalesRepSettings;
