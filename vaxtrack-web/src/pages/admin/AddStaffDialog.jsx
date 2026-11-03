import { useRef, useState } from "react";
import { UserPlus, X } from "lucide-react";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { friendlyErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { createStaffAccount, sendStaffSetupEmail } from "../../services/staffAccountCallables";

/**
 * Admin → Settings → User Management → Add staff.
 *
 * The server (createStaffAccount) makes the sign-in account with no password
 * and an approved profile. The new person then sets their own password from
 * Firebase's email, or from a one-time link the Admin passes on. Nobody but
 * them ever knows it. Riders are not added here: they apply in the rider app.
 */

const NEW_STAFF_ROLES = [
  { value: "dispatcher", label: "Dispatcher" },
  { value: "salesrep", label: "Med Rep" },
  { value: "admin", label: "Admin" },
];

const ROLE_NOTES = {
  dispatcher: "Assigns riders, prepares cargo and monitors deliveries.",
  salesrep: "Places orders for their doctors. Assign their territory next with Manage Territory.",
  admin: "Sees and can change everything, including other staff accounts.",
};

const LABEL = Object.fromEntries(NEW_STAFF_ROLES.map((r) => [r.value, r.label]));

/**
 * A one-time "set your password" link with a Copy button. When the browser
 * refuses clipboard access the link is selected so it can be copied by hand.
 */
export function SetupLinkBox({ link, name }) {
  const inputRef = useRef(null);
  const [copied, setCopied] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("Copied.");
    } catch {
      inputRef.current?.select();
      setCopied("Press Ctrl+C to copy the selected link.");
    }
  };
  return (
    <div className="staff-setup-link">
      <label htmlFor="staff-setup-link-input">One-time setup link</label>
      <div className="staff-setup-link-row">
        <input id="staff-setup-link-input" ref={inputRef} readOnly value={link} onFocus={(e) => e.target.select()} />
        <button type="button" className="settings-primary-action" onClick={copy}>
          Copy link
        </button>
      </div>
      <p className="staff-setup-link-note">
        It works once. Anyone with it can set this account's password, so send it only to {name}.
        {copied && <span role="status"> {copied}</span>}
      </p>
    </div>
  );
}

export default function AddStaffDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", email: "", role: "dispatcher" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  const savingRef = useRef(false);
  const dialogRef = useRef(null);
  useDialogFocus({ dialogRef, onDismiss: onClose, busy: saving });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await createStaffAccount({ name: form.name, email: form.email, role: form.role });
      const emailed = await sendStaffSetupEmail(result.email);
      setCreated({ ...result, name: form.name.trim().replace(/\s+/g, " "), emailed });
      onCreated?.(result);
    } catch (err) {
      logSafeError("Add staff", err);
      setError(friendlyErrorMessage(err, "The account could not be created. Nothing was saved — please try again."));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="settings-modal-backdrop">
      <div ref={dialogRef} className="settings-modal confirm-modal add-staff-modal" role="dialog" aria-modal="true" aria-labelledby="add-staff-title">
        <button type="button" className="settings-modal-close" onClick={onClose} disabled={saving} aria-label="Close">
          <X size={18} aria-hidden="true" />
        </button>

        <div className="settings-modal-avatar">
          <UserPlus size={26} />
        </div>

        {created ? (
          <>
            <h2 id="add-staff-title">{created.name} was added</h2>
            <p>
              {LABEL[created.role]} · {created.email}. Their account is active; they choose their own password before
              signing in.
            </p>
            <p className={created.emailed ? "staff-setup-sent" : "settings-modal-error"} role="status">
              {created.emailed
                ? `We emailed a "set your password" link to ${created.email}. Ask them to check spam if it does not arrive in a few minutes.`
                : "The set-password email could not be sent. Copy the link below and send it to them another way."}
            </p>
            {created.setupLink ? (
              <SetupLinkBox link={created.setupLink} name={created.name} />
            ) : (
              <p className="staff-setup-link-note">
                A setup link can be made later from their profile (View Profile → Copy setup link).
              </p>
            )}
            <div className="settings-modal-actions">
              <button type="button" className="settings-primary-action" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <h2 id="add-staff-title">Add staff</h2>
            <p>
              Creates a sign-in account. They set their own password from an email or a link you pass on. Riders apply
              in the rider app instead.
            </p>

            <div className="add-staff-fields">
              <div className="add-staff-field">
                <label htmlFor="add-staff-name">Full name</label>
                <input id="add-staff-name" value={form.name} onChange={set("name")} autoComplete="off" maxLength={80} required disabled={saving} />
              </div>
              <div className="add-staff-field">
                <label htmlFor="add-staff-email">Work email</label>
                <input id="add-staff-email" type="email" value={form.email} onChange={set("email")} autoComplete="off" maxLength={254} required disabled={saving} />
              </div>
              <div className="add-staff-field">
                <label htmlFor="add-staff-role">Role</label>
                <select id="add-staff-role" className="role-change-select" value={form.role} onChange={set("role")} disabled={saving}>
                  {NEW_STAFF_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <small className={form.role === "admin" ? "add-staff-role-note warn" : "add-staff-role-note"}>{ROLE_NOTES[form.role]}</small>
              </div>
            </div>

            {error && (
              <p className="settings-modal-error" role="alert">
                {error}
              </p>
            )}

            <div className="settings-modal-actions">
              <button type="submit" className="settings-primary-action" disabled={saving || !form.name.trim() || !form.email.trim()} aria-busy={saving}>
                {saving ? "Creating…" : "Create account"}
              </button>
              <button type="button" className="settings-light-action" onClick={onClose} disabled={saving}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
