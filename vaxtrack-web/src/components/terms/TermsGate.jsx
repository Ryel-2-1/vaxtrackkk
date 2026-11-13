import { useEffect, useRef, useState } from "react";
import { signOut } from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import { auth, db } from "../../firebase";
import { friendlyErrorMessage, logSafeError } from "../../services/liveDataErrors";
import {
  TERMS_CONSENT_LABEL,
  TERMS_REQUIRED_MESSAGE,
  TERMS_TITLE,
  hasAcceptedCurrentTerms,
  termsAcceptanceFields,
} from "../../services/termsAgreement";
import TermsContent from "./TermsContent";
import "./terms.css";

/**
 * Shown once, at first sign-in, to anyone who has not agreed to the current
 * Terms of Use and Data Privacy Agreement (services/termsAgreement.js): staff
 * whose account an Admin created, and everyone again when the wording changes.
 * Applicants already agreed on the sign-up form.
 *
 * Wraps a role's whole area (inside its route guard), so nothing of the portal
 * renders until the agreement is on record. Agreeing writes the version and the
 * server time to the person's own users/{uid}; the live listener then lets the
 * portal through. "Sign out" is the only other way off this screen.
 */
export default function TermsGate({ children }) {
  const uid = auth.currentUser?.uid ?? null;
  // "loading" | "needed" | "accepted". A read failure lets the portal through:
  // the route guard above has already established who this is, and a privacy
  // prompt must not lock staff out of deliveries during an outage.
  const [state, setState] = useState("loading");
  const [ticked, setTicked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const titleRef = useRef(null);

  useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(
      doc(db, "users", uid),
      (snap) => setState(hasAcceptedCurrentTerms(snap.exists() ? snap.data() : null) ? "accepted" : "needed"),
      (err) => {
        logSafeError("Terms agreement status", err);
        setState("accepted");
      }
    );
  }, [uid]);

  useEffect(() => {
    if (state === "needed") titleRef.current?.focus();
  }, [state]);

  if (!uid || state === "accepted") return children;
  if (state === "loading") return null;

  const agree = async (event) => {
    event.preventDefault();
    if (savingRef.current) return;
    if (!ticked) {
      setError(TERMS_REQUIRED_MESSAGE);
      document.getElementById("terms-gate-agree")?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await updateDoc(doc(db, "users", uid), termsAcceptanceFields(serverTimestamp()));
    } catch (err) {
      logSafeError("Accept terms", err);
      setError(friendlyErrorMessage(err, "Your agreement could not be saved. Please check your connection and try again."));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <main className="terms-gate">
      <form className="terms-gate-card" onSubmit={agree} noValidate aria-labelledby="terms-gate-title">
        <h1 id="terms-gate-title" tabIndex={-1} ref={titleRef}>{TERMS_TITLE}</h1>
        <p className="terms-gate-lead">Please read and agree before you continue. You only need to do this once.</p>
        <div className="terms-scroll" tabIndex={0} role="region" aria-label="Agreement text">
          <TermsContent />
        </div>
        <label className="terms-consent" htmlFor="terms-gate-agree">
          <input
            id="terms-gate-agree"
            type="checkbox"
            checked={ticked}
            disabled={saving}
            aria-describedby={error ? "terms-gate-error" : undefined}
            onChange={(e) => {
              setTicked(e.target.checked);
              setError("");
            }}
          />
          <span>{TERMS_CONSENT_LABEL}</span>
        </label>
        {error && <p id="terms-gate-error" className="terms-error" role="alert">{error}</p>}
        <div className="terms-gate-actions">
          <button type="button" className="terms-btn terms-btn-quiet" disabled={saving} onClick={() => signOut(auth)}>
            Sign out
          </button>
          <button type="submit" className="terms-btn terms-btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Agree and continue"}
          </button>
        </div>
      </form>
    </main>
  );
}
