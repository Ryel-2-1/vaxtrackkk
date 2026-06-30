import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { Eye, EyeOff, ArrowRight, Mail, Lock, User, Briefcase } from "lucide-react";
import { auth, db } from "../firebase";
import "./Auth.css";

const ROLE_OPTIONS = [
  { value: "salesrep", label: "Sales Representative" },
  { value: "dispatcher", label: "Dispatcher" },
];

function Register() {
  const navigate = useNavigate();
  const provider = new GoogleAuthProvider();

  const [fullName, setFullName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [selectedRole, setSelectedRole] = useState("salesrep");
  const [agree, setAgree] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleRegister = async (e) => {
    e.preventDefault();
    setError("");

    if (!fullName.trim() || !employeeId.trim() || !email.trim() || !password.trim()) {
      setError("Please complete all required fields.");
      return;
    }

    if (!agree) {
      setError("Please agree to the Terms of Service and Privacy Policy.");
      return;
    }

    try {
      setLoading(true);

      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      await setDoc(doc(db, "users", userCredential.user.uid), {
        fullName,
        employeeId,
        email,
        role: selectedRole,
        status: "pending",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      navigate("/pending");
    } catch (err) {
      console.error("Registration error:", err);
      setError("Registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleRegister = async () => {
    setError("");

    try {
      setLoading(true);
      const result = await signInWithPopup(auth, provider);

      await setDoc(
        doc(db, "users", result.user.uid),
        {
          fullName: result.user.displayName || "",
          employeeId: "",
          email: result.user.email || "",
          role: selectedRole,
          status: "pending",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      navigate("/pending");
    } catch (err) {
      console.error("Google registration error:", err);
      setError("Google registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card register-card-v2">
        <div className="auth-brand register-brand">
          <h1>Staff Registration</h1>
          <p>Create a secure VaxTrack staff account</p>
        </div>

        <form
          onSubmit={handleRegister}
          className="auth-form register-form"
          autoComplete="off"
        >
          <div className="register-field">
            <label>Full Name</label>

            <div className="register-input-box">
              <User size={18} />
              <input
                type="text"
                name="vaxtrack_register_fullname"
                autoComplete="off"
                placeholder="Enter full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
          </div>

          <div className="register-two-col">
            <div className="register-field">
              <label>Employee ID</label>

              <div className="register-input-box">
                <input
                  type="text"
                  name="vaxtrack_register_employee_id"
                  autoComplete="off"
                  placeholder="Enter employee ID"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                />
              </div>
            </div>

            <div className="register-field">
              <label>Work Email</label>

              <div className="register-input-box">
                <Mail size={18} />
                <input
                  type="email"
                  name="vaxtrack_register_email"
                  autoComplete="off"
                  placeholder="Enter work email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="register-field">
            <label>Applying as</label>

            <div className="register-input-box">
              <Briefcase size={18} />
              <select
                className="register-role-select"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
              >
                {ROLE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="register-field">
            <label>Password</label>

            <div className="register-input-box">
              <Lock size={18} />
              <input
                type={showPassword ? "text" : "password"}
                name="vaxtrack_register_password"
                autoComplete="new-password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />

              <button
                type="button"
                className="register-eye-btn"
                onClick={() => setShowPassword((prev) => !prev)}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>

            <small className="password-hint">
              Minimum 8 characters with at least one number.
            </small>
          </div>

          <label className="register-terms-clean">
            <input
              type="checkbox"
              checked={agree}
              onChange={() => setAgree((prev) => !prev)}
            />

            <span className="register-terms-text">
              I agree to the{" "}
              <span className="text-link-inline">Terms of Service</span> and{" "}
              <span className="text-link-inline">Privacy Policy</span> regarding
              professional data handling.
            </span>
          </label>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="primary-auth-btn" disabled={loading}>
            {loading ? "Creating..." : "Create Account"}
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
            onClick={handleGoogleRegister}
            disabled={loading}
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <p className="auth-footer-text">
            Already have a staff account?{" "}
            <Link to="/login" className="text-link">
              Log in
            </Link>
          </p>
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

export default Register;