import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  signOut,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Phone,
  User,
} from "lucide-react";
import { auth, db } from "../firebase";
import {
  APPLICABLE_ROLES,
  buildApplicationProfile,
  mapRegistrationError,
  validateApplication,
} from "../services/registration";
import "./Auth.css";

// Applying for access creates the visitor's OWN login and a pending profile.
// Every decision (validation, the pending shape, that admin can never be
// applied for) lives in ../services/registration and is unit-tested; this
// component only wires the real Firebase calls to it. Which Firebase project
// the account is created in is decided entirely by the build's env
// (.env.local / .env.staging -> vaxtrack-staging); no project is named here.
function Register() {
  const navigate = useNavigate();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState(APPLICABLE_ROLES[0].value);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Block duplicate submissions: the guard, not the disabled button, is the
    // real barrier against a double-click or Enter-while-pending.
    if (submitting) return;
    setError("");

    const check = validateApplication({
      name: fullName,
      email,
      password,
      confirmPassword,
      role,
    });
    if (!check.ok) {
      setError(check.message);
      return;
    }

    setSubmitting(true);
    try {
      const credential = await createUserWithEmailAndPassword(
        auth,
        check.value.email,
        password
      );
      try {
        await setDoc(doc(db, "users", credential.user.uid), {
          ...buildApplicationProfile({
            name: check.value.name,
            email: check.value.email,
            role,
            phone,
          }),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (writeError) {
        // The profile write failed (e.g. rules) after the auth account was
        // created — delete the orphaned account so the email stays reusable,
        // then surface the failure. Never leave a login with no profile.
        try {
          await deleteUser(credential.user);
        } catch {
          // best effort — nothing more we can do from the client
        }
        throw writeError;
      }

      // Applied successfully. The account is pending and may do nothing yet, so
      // sign out and show the pending screen — never a signed-in dashboard.
      await signOut(auth);
      navigate("/pending");
    } catch (err) {
      setError(mapRegistrationError(err?.code));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page forgot-page">
      <div className="auth-card forgot-card">
        <div className="auth-brand forgot-brand">
          <h1>VaxTrack</h1>
          <p>Apply for Access</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <h2 className="forgot-title">Create your account</h2>
          <p className="forgot-subtitle">
            Apply for a position. An administrator will review your request and
            approve, decline, or adjust it before you can sign in.
          </p>

          <label>Full Name</label>
          <div className="auth-input">
            <User size={16} />
            <input
              type="text"
              placeholder="Juan Dela Cruz"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
              autoComplete="name"
            />
          </div>

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

          <label>Phone Number (optional)</label>
          <div className="auth-input">
            <Phone size={16} />
            <input
              type="tel"
              placeholder="0917 000 0000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
              autoComplete="tel"
            />
          </div>

          <label>Position</label>
          <div className="auth-input">
            <Briefcase size={16} />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={submitting}
            >
              {APPLICABLE_ROLES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <label>Password</label>
          <div className="auth-input">
            <Lock size={16} />
            <input
              type={showPassword ? "text" : "password"}
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              autoComplete="new-password"
            />
            <button
              type="button"
              className="icon-ghost"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          <label>Confirm Password</label>
          <div className="auth-input">
            <Lock size={16} />
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              autoComplete="new-password"
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button className="primary-auth-btn" type="submit" disabled={submitting}>
            {submitting ? "Submitting…" : "Submit Application"}
            <ArrowRight size={16} />
          </button>

          <Link to="/login" className="back-login-link">
            <ArrowLeft size={14} />
            Back to Login
          </Link>
        </form>
      </div>
    </div>
  );
}

export default Register;
