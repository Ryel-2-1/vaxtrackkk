import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react";
import { auth, db } from "../firebase";
import "./Auth.css";

function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const redirectUserByRole = async (user) => {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      await signOut(auth);
      setError("No user profile found. Please contact the administrator.");
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
      setError("Your account was rejected. Please contact the administrator.");
      return;
    }

    if (status === "disabled") {
      await signOut(auth);
      setError("Your account is disabled. Please contact the administrator.");
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
      setError("Rider accounts must use the VaxTrack mobile app.");
      return;
    }

    await signOut(auth);
    setError("Unknown account role. Please contact the administrator.");
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");

    const loginEmail = email.trim();

    if (!loginEmail || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }

    // Email/password login only. Employee-ID login was removed for production
    // security — it required an unauthenticated read of the users collection,
    // which exposed the staff directory. Sign in with your email address.
    if (!loginEmail.includes("@")) {
      setError("Please log in with your email address.");
      return;
    }

    try {
      setLoading(true);

      const userCredential = await signInWithEmailAndPassword(
        auth,
        loginEmail,
        password
      );

      await redirectUserByRole(userCredential.user);
    } catch (err) {
      console.error("Login error:", err);
      setError("Invalid login credentials. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card login-card">
        <div className="auth-brand">
          <h1>VaxTrack Portal</h1>
        </div>

        <form onSubmit={handleLogin} className="auth-form" autoComplete="off">
          <label>Email</label>

          <div className="auth-input">
            <Mail size={16} />
            <input
              type="email"
              name="vaxtrack_login_email"
              autoComplete="off"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="auth-label-row">
            <label>Password</label>

            <Link to="/forgot-password" className="text-link small-link">
              Forgot Password?
            </Link>
          </div>

          <div className="auth-input">
            <Lock size={16} />
            <input
              type={showPassword ? "text" : "password"}
              name="vaxtrack_login_password"
              autoComplete="new-password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <button
              type="button"
              className="icon-ghost"
              onClick={() => setShowPassword((prev) => !prev)}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          <div className="auth-check-row">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={remember}
                onChange={() => setRemember((prev) => !prev)}
              />
              <span>Remember me</span>
            </label>
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="primary-auth-btn" disabled={loading}>
            {loading ? "Signing in..." : "Login to Portal"}
            {!loading && <ArrowRight size={16} />}
          </button>

          <small className="auth-copyright">
            © 2026 VaxTrack Philippines Medical Logistics.
            <br />
            Authorized Access Only.
          </small>
        </form>
      </div>
    </div>
  );
}

export default Login;