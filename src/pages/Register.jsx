import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { ArrowRight, Eye, EyeOff, Lock, Mail, User, IdCard } from "lucide-react";
import { auth, db } from "../firebase";

function Register() {
  const navigate = useNavigate();

  const [fullName, setFullName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("rider");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [agree, setAgree] = useState(false);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");

  const showMessage = (text, type = "error") => {
    setMessage(text);
    setMessageType(type);
  };

  const validateForm = () => {
    if (!fullName.trim()) {
      showMessage("Full name is required.");
      return false;
    }

    if (fullName.trim().length < 3) {
      showMessage("Full name must be at least 3 characters.");
      return false;
    }

    if (!employeeId.trim()) {
      showMessage("Employee ID is required.");
      return false;
    }

    if (!email.trim()) {
      showMessage("Work email is required.");
      return false;
    }

    if (!email.includes("@")) {
      showMessage("Please enter a valid email address.");
      return false;
    }

    if (!password.trim()) {
      showMessage("Password is required.");
      return false;
    }

    if (password.length < 6) {
      showMessage("Password must be at least 6 characters.");
      return false;
    }

    if (password !== confirmPassword) {
      showMessage("Password and confirm password do not match.");
      return false;
    }

    if (!agree) {
      showMessage("Please agree to the terms before creating an account.");
      return false;
    }

    return true;
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setMessage("");
    setMessageType("");

    if (!validateForm()) return;

    setLoading(true);

    try {
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );

      const uid = userCredential.user.uid;

      await setDoc(doc(db, "users", uid), {
        fullName: fullName.trim(),
        employeeId: employeeId.trim(),
        email: email.trim(),
        role,
        createdAt: serverTimestamp(),
      });

      showMessage("Account created successfully. Redirecting to login...", "success");

      setTimeout(() => {
        navigate("/");
      }, 1200);
    } catch (err) {
      console.error(err);

      if (err.code === "auth/email-already-in-use") {
        showMessage("This email is already registered.");
      } else if (err.code === "auth/invalid-email") {
        showMessage("Invalid email format.");
      } else if (err.code === "auth/weak-password") {
        showMessage("Password is too weak. Use at least 6 characters.");
      } else {
        showMessage("Registration failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="register-card">
        <div className="auth-logo">
          <div className="logo-circle">
            <span className="dot dot-yellow"></span>
            <span className="dot dot-orange"></span>
            <span className="dot dot-red"></span>
          </div>
        </div>

        <h1 className="register-title">Staff Registration</h1>
        <p className="brand-subtitle register-subtitle">
          Create a VaxTrack staff account for testing
        </p>

        <form onSubmit={handleRegister} className="auth-form">
          <label>Full Name</label>
          <div className="input-group">
            <User size={18} />
            <input
              type="text"
              placeholder="Juan Dela Cruz"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>

          <div className="form-row">
            <div>
              <label>Employee ID</label>
              <div className="input-group">
                <IdCard size={18} />
                <input
                  type="text"
                  placeholder="VT-2024-0000"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label>Role</label>
              <select
                className="select-field"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="rider">Rider</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>

          <label>Work Email</label>
          <div className="input-group">
            <Mail size={18} />
            <input
              type="email"
              placeholder="juan@vaxtrack.ph"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <label>Password</label>
          <div className="input-group">
            <Lock size={18} />
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Minimum 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          <label>Confirm Password</label>
          <div className="input-group">
            <Lock size={18} />
            <input
              type={showConfirmPassword ? "text" : "password"}
              placeholder="Retype your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
            >
              {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          <label className="remember-row">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            <span>
              I agree to the Terms of Service and Privacy Policy regarding
              professional data handling.
            </span>
          </label>

          {message && <p className={`form-message ${messageType}`}>{message}</p>}

          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? (
              "Creating account..."
            ) : (
              <>
                Create Professional Account <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        <div className="divider">
          <span></span>
          <p>or</p>
          <span></span>
        </div>

        <button className="google-button" type="button" disabled>
          <span>G</span>
          Sign up with Google
        </button>

        <p className="auth-footer">
          Already have a staff account?{" "}
          <button className="inline-link" onClick={() => navigate("/")}>
            Log in →
          </button>
        </p>
      </div>
    </div>
  );
}

export default Register;