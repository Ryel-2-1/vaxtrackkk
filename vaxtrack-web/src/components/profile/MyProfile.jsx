import { useRef, useState } from "react";
import { useLiveDraft } from "../useLiveDraft";
import StaleEditNotice from "../ui/StaleEditNotice";
import { sendPasswordResetEmail } from "firebase/auth";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Mail,
  Phone,
  Save,
  Shield,
  UserRound,
} from "lucide-react";
import { auth } from "../../firebase";
import { updateUserProfile } from "../../services/userService";
import {
  PROFILE_FIELD_LABELS,
  buildProfileUpdate,
  editableProfileFields,
  hasProfileChanges,
  readProfile,
  validateProfileEdit,
} from "../../services/profileModel";
import { requestPasswordReset, resendWaitMs } from "../../services/passwordReset";
import useOwnProfile from "./useOwnProfile";
import "./MyProfile.css";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { focusFirstInvalid } from "../../services/formValidation";

/**
 * "My profile" — one page for every web role (Admin, Sales Rep, Dispatcher).
 *
 * Reads and writes the signed-in user's OWN users/{uid} document. The user
 * may change their name and phone; email, role, status, employee ID and
 * organization are shown read-only because an administrator manages them.
 * Nothing here is stored only in the browser, and nothing claims to be saved
 * until Firestore has accepted the write.
 */
export default function MyProfile() {
  const { uid, profile: raw, loading, error } = useOwnProfile();
  // The editable fields, following the live profile while untouched; once
  // edited, a change made in another session is flagged instead of applied.
  const liveFields = raw ? editableProfileFields(raw) : null;
  const live = useLiveDraft(liveFields);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  // One save at a time, however fast Save is pressed.
  const savingRef = useRef(false);
  const [notice, setNotice] = useState(null);
  const [resetSending, setResetSending] = useState(false);
  const [resetSentAt, setResetSentAt] = useState(0);

  if (loading) {
    return (
      <div className="my-profile-state">
        <Loader2 size={28} className="spin" />
        <p>Loading your profile…</p>
      </div>
    );
  }
  if (!uid || error || !raw) {
    return (
      <div className="my-profile-state">
        <AlertTriangle size={28} />
        <p role="alert">{error ? liveErrorMessage(error, "your profile") : "Your profile could not be loaded. Please try again later."}</p>
      </div>
    );
  }

  const stored = readProfile(raw, { authEmail: auth.currentUser?.email ?? "" });
  const values = live.draft;
  const changed = hasProfileChanges(raw, values);
  // Saving stale values would silently undo a change made elsewhere.
  const staleLabels = live.stale.map((f) => PROFILE_FIELD_LABELS[f] ?? f);
  const blockedByStale = staleLabels.length > 0;

  const edit = (field) => (event) => {
    live.setField(field, event.target.value);
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    setNotice(null);
  };

  const handleSave = async () => {
    const check = validateProfileEdit(values);
    if (!check.ok) {
      setErrors(check.errors);
      // Focus the first field with a problem; the typed values stay.
      focusFirstInvalid(["name", "phone"], check.errors, (f) => document.getElementById(`my-profile-${f}`));
      return;
    }
    if (savingRef.current || blockedByStale) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      await updateUserProfile(uid, buildProfileUpdate(raw, check.value));
      // The live subscription now carries the saved values; they are the new
      // baseline, so their echo is not mistaken for a change made elsewhere.
      live.markSaved({ name: check.value.name, phone: check.value.phone });
      setNotice({ tone: "success", text: "Your profile was updated." });
    } catch (err) {
      logSafeError("Save profile", err);
      setNotice({
        tone: "error",
        text: friendlyErrorMessage(err, "Your profile could not be saved. Your changes are still here — please try again."),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handlePasswordReset = async () => {
    const wait = resendWaitMs({ now: Date.now(), lastSentAt: resetSentAt });
    if (wait > 0) {
      setNotice({
        tone: "warning",
        text: `Please wait ${Math.ceil(wait / 1000)} seconds before requesting another email.`,
      });
      return;
    }
    setResetSending(true);
    setNotice(null);
    const outcome = await requestPasswordReset({
      email: stored.email,
      send: (email) => sendPasswordResetEmail(auth, email),
    });
    setResetSending(false);
    if (outcome.kind === "sent") {
      setResetSentAt(Date.now());
      setNotice({
        tone: "success",
        text: `A password reset link was sent to ${stored.email}. Check your inbox and spam folder.`,
      });
    } else {
      setNotice({ tone: "error", text: outcome.message });
    }
  };

  const showOrganization = stored.roleKey === "salesrep" || stored.organization !== "";

  return (
    <div className="my-profile">
      <header className="my-profile-header">
        <h2>My profile</h2>
        <p>Your name and phone number. Account details are managed by your administrator.</p>
      </header>

      {notice && (
        <div className={`my-profile-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.tone === "success" ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="my-profile-grid">
        <section className="my-profile-card" aria-labelledby="my-profile-info">
          <h3 id="my-profile-info">
            <UserRound size={18} /> Profile
          </h3>

          <label className="my-profile-field" htmlFor="my-profile-name">
            <span>Full name</span>
            <input
              id="my-profile-name"
              type="text"
              autoComplete="name"
              maxLength={80}
              value={values.name}
              onChange={edit("name")}
              aria-invalid={errors.name ? "true" : undefined}
              aria-describedby={errors.name ? "my-profile-name-error" : undefined}
            />
            {errors.name && <small id="my-profile-name-error" className="my-profile-error">{errors.name}</small>}
          </label>

          <label className="my-profile-field" htmlFor="my-profile-phone">
            <span>
              <Phone size={14} /> Phone / contact number
            </span>
            <input
              id="my-profile-phone"
              type="tel"
              autoComplete="tel"
              maxLength={30}
              placeholder="e.g. +63 917 123 4567"
              value={values.phone}
              onChange={edit("phone")}
              aria-invalid={errors.phone ? "true" : undefined}
              aria-describedby={errors.phone ? "my-profile-phone-error" : undefined}
            />
            {errors.phone && <small id="my-profile-phone-error" className="my-profile-error">{errors.phone}</small>}
          </label>

          <StaleEditNotice
            labels={staleLabels}
            what="your profile"
            disabled={saving}
            onLoadLatest={live.loadLatest}
            onKeepMine={live.keepMine}
          />

          <button
            type="button"
            className="my-profile-save"
            onClick={handleSave}
            disabled={saving || !changed || blockedByStale}
          >
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {saving ? "Saving…" : "Save changes"}
          </button>
        </section>

        <div className="my-profile-side">
          <section className="my-profile-card" aria-labelledby="my-profile-account">
            <h3 id="my-profile-account">
              <Shield size={18} /> Account details
            </h3>
            <dl className="my-profile-details">
              <div>
                <dt>
                  <Mail size={14} /> Email
                </dt>
                <dd>{stored.email || "—"}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{stored.roleLabel}</dd>
              </div>
              <div>
                <dt>Account status</dt>
                <dd>
                  <span className={`my-profile-status ${stored.statusKey}`}>{stored.statusLabel}</span>
                </dd>
              </div>
              <div>
                <dt>Employee ID</dt>
                <dd>{stored.employeeId || "—"}</dd>
              </div>
              {showOrganization && (
                <div>
                  <dt>Organization</dt>
                  <dd>{stored.organization || "—"}</dd>
                </div>
              )}
            </dl>
            <p className="my-profile-note">
              Your email, role, status, employee ID and organization are managed by
              your administrator.
            </p>
          </section>

          <section className="my-profile-card" aria-labelledby="my-profile-security">
            <h3 id="my-profile-security">
              <KeyRound size={18} /> Password
            </h3>
            <p className="my-profile-note">
              We will email a secure link to {stored.email || "your sign-in address"} so
              you can choose a new password.
            </p>
            <button
              type="button"
              className="my-profile-secondary"
              onClick={handlePasswordReset}
              disabled={resetSending || !stored.email}
            >
              {resetSending ? <Loader2 size={16} className="spin" /> : <Mail size={16} />}
              {resetSending ? "Sending…" : "Send password reset email"}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
