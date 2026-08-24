import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword } from "firebase/auth";
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

export default Register;