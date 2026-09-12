import { useState } from "react";
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
  ClipboardList,
  Truck,
  Bike,
  Smartphone,
  AlertCircle,
  Clock,
  Info,
  Snowflake,
} from "lucide-react";
import { auth, db } from "../firebase";
import "./Login.css";

// Portal options. The selected portal is only the intended destination — the
// authenticated Firestore role is always the authority (see handleLogin).
const ROLES = [
  {
    key: "admin",
    label: "Admin",
    Icon: ShieldCheck,
    subtitle: "Inventory, users, alerts, and system oversight",
  },
  {
    key: "salesrep",
    label: "Sales Rep",
    Icon: ClipboardList,
    subtitle: "Place clinic orders and track requests",
  },
  {
    key: "dispatcher",
    label: "Dispatcher",
    Icon: Truck,
    subtitle: "Assign riders and manage active shipments",
  },
  {
    key: "rider",
    label: "Rider",
    Icon: Bike,
    subtitle: "Continue through the VaxTrack Rider mobile app",
  },
];

// Canonical role conventions, mirrored from the existing route guards.
const SALES_REP_ROLES = [
  "salesrep",
  "sales_rep",
  "sales-rep",
  "sales representative",
];
const ROLE_ROUTES = {
  admin: "/admin",
  salesrep: "/sales-rep",
  dispatcher: "/dispatcher",
};

function storedRoleMatchesSelection(storedRole, selectedKey) {
  if (selectedKey === "admin") return storedRole === "admin";
  if (selectedKey === "dispatcher") return storedRole === "dispatcher";
  if (selectedKey === "salesrep") return SALES_REP_ROLES.includes(storedRole);
  return false; // rider is never a web portal
}

// Human label + the portal tab for a stored role, for the mismatch message.
function portalForStoredRole(storedRole) {
  if (storedRole === "admin") return { name: "Administrator", tab: "Admin" };
  if (storedRole === "dispatcher")
    return { name: "Dispatcher", tab: "Dispatcher" };
  if (SALES_REP_ROLES.includes(storedRole))
    return { name: "Sales Representative", tab: "Sales Rep" };
  return null;
}

// Map Firebase auth error codes to understandable, non-technical messages.
function mapAuthError(err) {
  const code = err?.code || "";
  if (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found" ||
    code === "auth/invalid-email"
  ) {
    return "Incorrect email or password.";
  }
  if (code === "auth/network-request-failed") {
    return "Unable to connect. Check your internet connection and try again.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Please wait before trying again.";
  }
  if (code === "auth/user-disabled") {
    return "This account is currently disabled. Contact your administrator for assistance.";
  }
  return "Something went wrong. Please try again.";
}

const NOTICE_ICON = { error: AlertCircle, pending: Clock, info: Info };

function Login() {
  const navigate = useNavigate();

  const [selectedRole, setSelectedRole] = useState("admin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, title, body? }
  const [loading, setLoading] = useState(false);

  const activeRole = ROLES.find((r) => r.key === selectedRole) || ROLES[0];
  const isRider = selectedRole === "rider";

  const chooseRole = (key) => {
    if (key === selectedRole) return;
    setSelectedRole(key);
    setNotice(null); // a mismatch/error for one portal shouldn't linger on another
  };

  // Non-approved status / mismatch / missing profile all end here: sign the
  // Firebase session out, clear the password, and explain inline.
  const rejectAndSignOut = async (nextNotice) => {
    try {
      await signOut(auth);
    } catch {
      // ignore sign-out failures; we still show the notice and never route
    }
    setPassword("");
    setNotice(nextNotice);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (loading) return; // prevent duplicate submissions / Firebase calls
    setNotice(null);

    const loginEmail = email.trim();
    if (!loginEmail || !password) {
      setNotice({ tone: "error", title: "Enter your email and password." });
      return;
    }
    if (!loginEmail.includes("@")) {
      setNotice({ tone: "error", title: "Please log in with your email address." });
      return;
    }

    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, loginEmail, password);

      // Authoritative profile from users/{uid}.
      const snap = await getDoc(doc(db, "users", cred.user.uid));
      if (!snap.exists()) {
        await rejectAndSignOut({
          tone: "error",
          title: "Account profile not found",
          body: "Your account profile could not be found. Contact your administrator.",
        });
        return;
      }

      const data = snap.data();
      const role = String(data.role || "").toLowerCase().trim();
      const status = String(data.status || "approved").toLowerCase().trim();

      // 1) Status gate — any non-approved status blocks portal access + signs out.
      if (status === "pending" || status === "pending_approval") {
        await rejectAndSignOut({
          tone: "pending",
          title: "Account pending approval",
          body: "Your administrator is currently reviewing this account. You’ll receive access once it is approved.",
        });
        return;
      }
      if (status === "rejected") {
        await rejectAndSignOut({
          tone: "error",
          title: "Account not approved",
          body: "Account access was not approved. Contact your administrator if you believe this is incorrect.",
        });
        return;
      }
      if (status === "disabled") {
        await rejectAndSignOut({
          tone: "error",
          title: "Account disabled",
          body: "This account is currently disabled. Contact your administrator for assistance.",
        });
        return;
      }

      // 2) Rider accounts are mobile-only — never authenticate into a web portal.
      if (role === "rider") {
        await rejectAndSignOut({
          tone: "info",
          title: "Use the VaxTrack Rider app",
          body: "This account is registered as a Rider. Sign in with the same email and password in the VaxTrack Rider mobile app.",
        });
        return;
      }

      // 3) Selected portal vs stored role. The UI selection never grants access.
      if (!storedRoleMatchesSelection(role, selectedRole)) {
        const portal = portalForStoredRole(role);
        await rejectAndSignOut({
          tone: "error",
          title: portal
            ? `This account is registered as ${portal.name}. Select ${portal.tab} to continue.`
            : "This account's role is not recognized for web access. Contact your administrator.",
        });
        return;
      }

      // 4) Approved + role matches → route. Route guards remain the final check.
      navigate(ROLE_ROUTES[selectedRole]);
    } catch (err) {
      console.error("Login error:", err);
      setNotice({ tone: "error", title: mapAuthError(err) });
    } finally {
      setLoading(false);
    }
  };

  const NoticeIcon = notice ? NOTICE_ICON[notice.tone] || AlertCircle : null;

  return (
    <div className="vlogin">
      {/* Left visual panel */}
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
            Select your role and enter your credentials.
          </p>

          {/* Role selector */}
          <div
            className="vlogin-roles"
            role="group"
            aria-label="Select your portal"
          >
            {ROLES.map((r) => {
              const selected = r.key === selectedRole;
              return (
                <button
                  key={r.key}
                  type="button"
                  className="vlogin-role"
                  aria-pressed={selected}
                  onClick={() => chooseRole(r.key)}
                >
                  <r.Icon size={16} aria-hidden="true" />
                  <span>{r.label}</span>
                </button>
              );
            })}
          </div>
          <p className="vlogin-role-sub">{activeRole.subtitle}</p>

          {/* Inline authentication feedback (announced to assistive tech) */}
          <div aria-live="assertive">
            {notice && (
              <div
                id="vlogin-notice"
                className={`vlogin-notice tone-${notice.tone}`}
                role="alert"
              >
                {NoticeIcon && <NoticeIcon size={16} aria-hidden="true" />}
                <div>
                  <strong>{notice.title}</strong>
                  {notice.body && <p>{notice.body}</p>}
                </div>
              </div>
            )}
          </div>

          {isRider ? (
            /* Rider mobile-app handoff — no web portal, no invented links */
            <div className="vlogin-rider">
              <span className="vlogin-rider-icon">
                <Smartphone size={22} aria-hidden="true" />
              </span>
              <h2>VaxTrack Rider Mobile App</h2>
              <p>
                Rider operations are handled in the Android app — real-time GPS
                tracking, delivery updates, in-app navigation, and route
                compliance.
              </p>
              <ul>
                <li>Sign in with the same approved VaxTrack email and password.</li>
                <li>Deliveries, proof of delivery, and status updates live here.</li>
              </ul>
              <div className="vlogin-rider-note">
                <Info size={15} aria-hidden="true" />
                <span>
                  Install the official VaxTrack Rider app provided by your
                  administrator. To sign in to a web portal instead, choose
                  Admin, Sales Rep, or Dispatcher above.
                </span>
              </div>
            </div>
          ) : (
            /* Admin / Sales Rep / Dispatcher credential form */
            <form className="vlogin-form" onSubmit={handleLogin}>
              <div className="vlogin-field">
                <label className="vlogin-label" htmlFor="vlogin-email">
                  Email address
                </label>
                <div
                  className={`vlogin-input${
                    notice?.tone === "error" ? " has-error" : ""
                  }`}
                >
                  <Mail size={16} aria-hidden="true" />
                  <input
                    id="vlogin-email"
                    type="email"
                    autoComplete="email"
                    placeholder="Enter your work email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-describedby={notice ? "vlogin-notice" : undefined}
                    aria-invalid={notice?.tone === "error" || undefined}
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
                <div
                  className={`vlogin-input${
                    notice?.tone === "error" ? " has-error" : ""
                  }`}
                >
                  <Lock size={16} aria-hidden="true" />
                  <input
                    id="vlogin-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-describedby={notice ? "vlogin-notice" : undefined}
                    aria-invalid={notice?.tone === "error" || undefined}
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
          )}

          <small className="vlogin-copyright">
            © 2026 VaxTrack Philippines Medical Logistics — Authorized access only.
          </small>
        </div>
      </main>
    </div>
  );
}

export default Login;
