import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, Mail } from "lucide-react";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../firebase";
import {
  RESEND_COOLDOWN_MS,
  requestPasswordReset,
} from "../services/passwordReset";
import "./Auth.css";

// The one real side effect, wired to the pure requestPasswordReset. Every
// decision — validation, the neutral message, which failures are shown, and the
// account-existence hiding — lives in ../services/passwordReset and is unit
// tested; this component only renders what that returns.
//
// Which Firebase project the mail comes from is decided entirely by the build's
// env (.env.local / .env.staging → vaxtrack-staging). No project is named here.
const send = (email) => sendPasswordResetEmail(auth, email);

const COOLDOWN_SECONDS = Math.ceil(RESEND_COOLDOWN_MS / 1000);

function ForgotPassword() {
  const [step, setStep] = useState("request"); // "request" | "sent"
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState(""); // neutral confirmation on the sent screen
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const startCooldown = () => {
    clearInterval(timerRef.current);
    const startedAt = Date.now();
    setCooldown(COOLDOWN_SECONDS);
    timerRef.current = setInterval(() => {
      const remaining = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - startedAt)) / 1000
      );
      if (remaining <= 0) {
        setCooldown(0);
        clearInterval(timerRef.current);
      } else {
        setCooldown(remaining);
      }
    }, 1000);
  };

  // The single request path, shared by the first submit and Resend. The
  // in-flight guard here — not the disabled button — is what actually blocks a
  // duplicate submission (double-click, Enter-while-pending, a stale click).
  const submit = async (address) => {
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const outcome = await requestPasswordReset({ email: address, send });
      if (outcome.kind === "sent") {
        // Reached only after Firebase resolved the request (or the neutralised
        // user-not-found): success is never shown before a completed call.
        setEmail(outcome.email);
        setNotice(outcome.message);
        setStep("sent");
        startCooldown();
      } else {
        // "invalid" (local) or "error" (infrastructure): stay put and explain.
        setError(outcome.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestSubmit = (e) => {
    e.preventDefault();
    submit(email);
  };

  const handleResend = () => {
    if (submitting || cooldown > 0) return;
    submit(email);
  };

  return (
    <div className="auth-page forgot-page">
      {step === "request" && (
        <div className="auth-card forgot-card">
          <div className="auth-brand forgot-brand">
            <h1>VaxTrack</h1>
            <p>Forgot Password</p>
          </div>

          <form className="auth-form" onSubmit={handleRequestSubmit}>
            <h2 className="forgot-title">Reset Password</h2>
            <p className="forgot-subtitle">
              Enter your registered email and we will send you a password reset
              link.
            </p>

            <label>Email Address</label>
            <div className="auth-input">
              <Mail size={16} />
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                autoComplete="email"
              />
            </div>

            {error && <div className="auth-error">{error}</div>}

            <button
              className="primary-auth-btn"
              type="submit"
              disabled={submitting}
            >
              {submitting ? "Sending…" : "Send Reset Link"}
              <ArrowRight size={16} />
            </button>

            <Link to="/login" className="back-login-link">
              <ArrowLeft size={14} />
              Back to Login
            </Link>
          </form>
        </div>
      )}

      {step === "sent" && (
        <div className="auth-card forgot-card success-card">
          <div className="success-icon">
            <CheckCircle2 size={28} />
          </div>

          <h2>Check your email</h2>

          <p>{notice}</p>

          {error && <div className="auth-error">{error}</div>}

          <button
            type="button"
            className="resend-code-btn"
            onClick={handleResend}
            disabled={submitting || cooldown > 0}
          >
            {cooldown > 0
              ? `Resend email in ${cooldown}s`
              : submitting
                ? "Sending…"
                : "Resend email"}
          </button>

          <Link to="/login" className="primary-auth-btn success-login-btn">
            Back to Login
            <ArrowRight size={16} />
          </Link>

          <small>
            The link expires after a short time for your security. If it does,
            request a new one.
          </small>
        </div>
      )}
    </div>
  );
}

export default ForgotPassword;
