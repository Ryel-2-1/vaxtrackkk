import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Mail, Lock, Eye, EyeOff, ArrowRight } from "lucide-react";
import { auth, db } from "../firebase";
import "./Auth.css";

function Login() {
  const navigate = useNavigate();
  const provider = new GoogleAuthProvider();

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

  const handleGoogleLogin = async () => {
    setError("");

    try {
      setLoading(true);

      const result = await signInWithPopup(auth, provider);

      await redirectUserByRole(result.user);
    } catch (err) {
      console.error("Google login error:", err);
      setError("Google sign in failed. Please try again.");
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

          <div className="auth-divider">
            <span></span>
            <p>or</p>
            <span></span>
          </div>

          <button
            type="button"
            className="google-auth-btn"
            onClick={handleGoogleLogin}
            disabled={loading}
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <p className="auth-footer-text">
            Don&apos;t have an Account?{" "}
            <Link to="/register" className="text-link">
              Register here
            </Link>
          </p>

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

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.1 0 9.8-1.9 13.3-5.1l-6.2-5.2C29.1 35.2 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.5 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.7l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

export default Login;