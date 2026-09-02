import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  ArrowRight,
  ShieldCheck,
  AlertCircle,
  Info,
  Snowflake,
} from "lucide-react";
import { auth, db } from "../firebase";
import "./Login.css";

// Presentation-only refresh of the sign-in screen.
//
// AUTHENTICATION AUTHORITY IS UNCHANGED. `redirectUserByRole` below is the
// original function: the role stored on `users/{uid}` decides the destination,
// the same status gates run in the same order, and the same accounts are signed
// out. There is no portal picker — a role chosen in the UI could only ever
// contradict the account, so the screen never offers one. Route guards remain
// the final authority on every destination.

// Icon per notice tone. Tones mirror the outcomes the original produced.
const NOTICE_ICON = { error: AlertCircle, info: Info };

// Firebase auth codes -> operator-facing text.
//
// Credential failures all collapse to ONE message on purpose: distinguishing
// "no such user" from "wrong password" would let anyone probe which email
// addresses have accounts. Non-credential failures get their own text because
// they tell the user something actionable and reveal nothing about an account.
function mapAuthError(code) {
  if (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found" ||
    code === "auth/invalid-email"
  ) {
    return "Invalid email or password.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many sign-in attempts. Please wait a moment and try again.";
  }
  if (code === "auth/network-request-failed") {
    return "Unable to connect. Check your internet connection and try again.";
  }
  if (code === "auth/user-disabled") {
    return "This account is currently disabled. Contact your administrator for assistance.";
  }
  return "Something went wrong. Please try again.";
}

function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }
  const [loading, setLoading] = useState(false);
  // Duplicate-submit guard. `loading` drives the disabled button (which already
  // stops a real double-click), but React state is not updated synchronously —
  // two submits dispatched in the SAME tick would both read the old value and
  // both call Firebase. A ref flips immediately, so only one request is ever
  // in flight.
  const submittingRef = useRef(false);

  const showError = (text) => setNotice({ tone: "error", text });
  const showInfo = (text) => setNotice({ tone: "info", text });

  // UNCHANGED from the previous implementation: same checks, same order, same
  // navigation targets, same sign-outs. Only the presentation of the resulting
  // message differs (an announced notice instead of a plain div).
  const redirectUserByRole = async (user) => {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      await signOut(auth);
      showError("No user profile found. Please contact the administrator.");
      return;
    }

    const userData = userSnap.data();

    const role = (userData.role || "").toLowerCase().trim();
    const status = (userData.status || "approved").toLowerCase().trim();

    if (status === "pending" || status === "pending_approval") {
      navigate("/pending");
      return;
    }

    if (status === "rejected") {
      await signOut(auth);
      showError("Your account was rejected. Please contact the administrator.");
      return;
    }

    if (status === "disabled") {
      await signOut(auth);
      showError("Your account is disabled. Please contact the administrator.");
      return;
    }

    if (role === "admin") {
      navigate("/admin");
      return;
    }

    if (role === "dispatcher") {
      navigate("/dispatcher");
      return;
    }

    if (
      role === "salesrep" ||
      role === "sales_rep" ||
      role === "sales-rep" ||
      role === "sales representative"
    ) {
      navigate("/sales-rep");
      return;
    }

    if (role === "rider") {
      await signOut(auth);
      showInfo("Rider accounts must use the VaxTrack mobile app.");
      return;
    }

    await signOut(auth);
    showError("Unknown account role. Please contact the administrator.");
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return; // one Firebase call at a time
    setNotice(null);

    const loginEmail = email.trim();

    if (!loginEmail || !password.trim()) {
      showError("Please enter your email and password.");
      return;
    }

    // Email/password login only. Employee-ID login was removed for production
    // security — it required an unauthenticated read of the users collection,
    // which exposed the staff directory. Sign in with your email address.
    if (!loginEmail.includes("@")) {
      showError("Please log in with your email address.");
      return;
    }

    // Set only AFTER validation, so a rejected form never latches the guard.
    submittingRef.current = true;
    setLoading(true);
    try {
      const userCredential = await signInWithEmailAndPassword(
        auth,
        loginEmail,
        password
      );

      await redirectUserByRole(userCredential.user);
    } catch (err) {
      // Log the CODE only — never the error object, the email, or any profile
      // data, so credentials cannot leak into the console.
      console.error("Login failed:", err?.code || "unknown");
      showError(mapAuthError(err?.code));
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  const NoticeIcon = notice ? NOTICE_ICON[notice.tone] || AlertCircle : null;
  const hasError = notice?.tone === "error";

  return (
    <div className="vlogin">
      {/* Left visual panel — decorative, hidden from assistive tech */}
      <aside className="vlogin-visual" aria-hidden="true">
        <Snowflake className="vlogin-motif" size={280} strokeWidth={1} />
        <div className="vlogin-brand">
          <span className="vlogin-brand-mark">
            <Snowflake size={18} />
          </span>
          <span className="vlogin-brand-name">VaxTrack</span>
        </div>
        <div className="vlogin-visual-msg">
          <h2>Secure Cold-Chain Operations</h2>
          <p>
            Authorized access for pharmaceutical inventory, dispatch, and
            delivery monitoring.
          </p>
        </div>
      </aside>

      {/* Right authentication panel */}
      <main className="vlogin-panel">
        <div className="vlogin-card">
          <div className="vlogin-mobile-brand">
            <span className="vlogin-brand-mark">
              <Snowflake size={18} />
            </span>
            <span className="vlogin-brand-name">VaxTrack</span>
          </div>

          <h1 className="vlogin-title">Sign in to VaxTrack</h1>
          <p className="vlogin-sub">
            Enter your work email and password to continue.
          </p>

          {/* Static statement, not a control — no portal is selectable. */}
          <p className="vlogin-role-note">
            <Info size={15} aria-hidden="true" />
            <span>Portal access is based on your registered account role.</span>
          </p>

          {/* Inline authentication feedback, announced to assistive tech */}
          <div aria-live="assertive">
            {notice && (
              <div
                id="vlogin-notice"
                className={`vlogin-notice tone-${notice.tone}`}
                role="alert"
              >
                {NoticeIcon && <NoticeIcon size={16} aria-hidden="true" />}
                <div>
                  <strong>{notice.text}</strong>
                </div>
              </div>
            )}
          </div>

          <form className="vlogin-form" onSubmit={handleLogin}>
            <div className="vlogin-field">
              <label className="vlogin-label" htmlFor="vlogin-email">
                Email address
              </label>
              <div className={`vlogin-input${hasError ? " has-error" : ""}`}>
                <Mail size={16} aria-hidden="true" />
                <input
                  id="vlogin-email"
                  type="email"
                  autoComplete="email"
                  placeholder="Enter your work email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  aria-describedby={notice ? "vlogin-notice" : undefined}
                  aria-invalid={hasError || undefined}
                />
              </div>
            </div>

            <div className="vlogin-field">
              <div className="vlogin-label-row">
                <label className="vlogin-label" htmlFor="vlogin-password">
                  Password
                </label>
                <Link to="/forgot-password" className="vlogin-forgot">
                  Forgot password?
                </Link>
              </div>
              <div className={`vlogin-input${hasError ? " has-error" : ""}`}>
                <Lock size={16} aria-hidden="true" />
                <input
                  id="vlogin-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  aria-describedby={notice ? "vlogin-notice" : undefined}
                  aria-invalid={hasError || undefined}
                />
                <button
                  type="button"
                  className="vlogin-toggle"
                  onClick={() => setShowPassword((p) => !p)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" className="vlogin-btn" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
              {!loading && <ArrowRight size={16} aria-hidden="true" />}
            </button>

            <div className="vlogin-security">
              <ShieldCheck size={15} aria-hidden="true" />
              <span>
                Access is restricted to authorized personnel. Activity is
                monitored for security and compliance.
              </span>
            </div>
          </form>

          <small className="vlogin-copyright">
            © 2026 VaxTrack Philippines Medical Logistics — Authorized access
            only.
          </small>
        </div>
      </main>
    </div>
  );
}

export default Login;
