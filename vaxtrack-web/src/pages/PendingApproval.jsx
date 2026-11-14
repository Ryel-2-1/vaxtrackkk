import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2, Clock, LogOut, Mail, ShieldCheck } from "lucide-react";
import { sendEmailVerification, signOut } from "firebase/auth";
import { auth } from "../firebase";
import { verificationSendMessage } from "../services/emailVerification";

function PendingApproval() {
  const navigate = useNavigate();
  const location = useLocation();
  // Signed in when a pending applicant logs in; signed out straight after
  // sign-up (the account may do nothing yet). Either way the page says what
  // happens next. An Admin can approve only a verified email (2026-11-14).
  const user = auth.currentUser;
  const email = user?.email || location.state?.email || "";
  const [verified, setVerified] = useState(Boolean(user?.emailVerified));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const resend = async () => {
    if (!user || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await sendEmailVerification(user);
      setNotice({ tone: "info", text: verificationSendMessage(null, email) });
    } catch (error) {
      setNotice({ tone: "error", text: verificationSendMessage(error?.code, email) });
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    if (!user || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await user.reload();
      const now = Boolean(auth.currentUser?.emailVerified);
      setVerified(now);
      if (!now) setNotice({ tone: "info", text: "Not verified yet. Open the link in the email, then try again." });
    } catch {
      setNotice({ tone: "error", text: "Couldn't check right now. Please try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="pending-card">
        <div className="pending-icon">
          <Clock size={42} />
        </div>

        <h1>Account Pending Approval</h1>

        <p>
          Your VaxTrack account has been created, but it still needs to be
          reviewed and approved by an administrator before you can access the
          portal.
        </p>

        <div className={`pending-note pending-verify${verified ? " is-verified" : ""}`} role="status">
          {verified ? <CheckCircle2 size={20} aria-hidden="true" /> : <Mail size={20} aria-hidden="true" />}
          <span>
            {verified
              ? "Your email is verified. An administrator can now approve your account."
              : `Verify your email first: open the link we sent${email ? ` to ${email}` : ""}. An administrator can approve your account only after that.${user ? "" : " To get a new link, sign in again."}`}
          </span>
        </div>

        {user && !verified && (
          <div className="pending-verify-actions">
            <button type="button" className="pending-secondary" onClick={recheck} disabled={busy}>
              I&apos;ve opened the link
            </button>
            <button type="button" className="pending-secondary" onClick={resend} disabled={busy}>
              Send the link again
            </button>
          </div>
        )}
        {notice && (
          <p className={`pending-verify-notice${notice.tone === "error" ? " is-error" : ""}`} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        )}

        <div className="pending-note">
          <ShieldCheck size={20} />
          <span>
            Once approved, you will be able to log in and access your assigned
            dashboard. You will receive access based on the role you applied for.
          </span>
        </div>

        <button className="primary-button" onClick={handleLogout}>
          <LogOut size={16} />
          Back to Login
        </button>
      </div>
    </div>
  );
}

export default PendingApproval;
