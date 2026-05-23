import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  ArrowRight,
  Eye,
  EyeOff,
  IdCard,
  Lock,
  Mail,
  Phone,
  User,
} from "lucide-react";
import { auth, db } from "../firebase";

function SalesRepRegister() {
  const navigate = useNavigate();

  const [fullName, setFullName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [workEmail, setWorkEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);

  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");

  const showMessage = (text, type = "error") => {
    setMessage(text);
    setMessageType(type);
  };

  const validateForm = () => {
    const nameRegex = /^[a-zA-Z\s.'-]+$/;
    const hasUppercase = /[A-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);

    if (!fullName.trim()) {
      showMessage("Full name is required.");
      return false;
    }

    if (fullName.trim().length < 3) {
      showMessage("Full name must be at least 3 characters.");
      return false;
    }

    if (!nameRegex.test(fullName.trim())) {
      showMessage("Full name must not contain numbers or invalid symbols.");
      return false;
    }

    if (!employeeId.trim()) {
      showMessage("Employee ID is required.");
      return false;
    }

    if (!workEmail.trim()) {
      showMessage("Work email is required.");
      return false;
    }

    if (!workEmail.includes("@") || !workEmail.includes(".")) {
      showMessage("Please enter a valid work email.");
      return false;
    }

    if (!phoneNumber.trim()) {
      showMessage("Phone number is required.");
      return false;
    }

    if (password.length < 6) {
      showMessage("Password must be at least 6 characters.");
      return false;
    }

    if (!hasUppercase) {
      showMessage("Password must contain at least 1 uppercase letter.");
      return false;
    }

    if (!hasNumber) {
      showMessage("Password must contain at least 1 number.");
      return false;
    }

    if (!agree) {
      showMessage("Please agree to the Terms of Service and Privacy Policy.");
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
        workEmail.trim(),
        password
      );

      const uid = userCredential.user.uid;

      await setDoc(doc(db, "users", uid), {
        fullName: fullName.trim(),
        employeeId: employeeId.trim(),
        email: workEmail.trim(),
        phoneNumber: phoneNumber.trim(),
        role: "pending",
        department: "unassigned",
        status: "pending",
        requestedRole: "sales_rep",
        requestedDepartment: "sales",
        createdAt: serverTimestamp(),
      });

      showMessage(
        "Account submitted successfully. Please wait for manager approval.",
        "success"
      );

      setTimeout(() => {
        navigate("/pending");
      }, 1000);
    } catch (err) {
      console.error(err);

      if (err.code === "auth/email-already-in-use") {
        showMessage("This email is already registered.");
      } else if (err.code === "auth/invalid-email") {
        showMessage("Invalid email format.");
      } else if (err.code === "auth/weak-password") {
        showMessage("Password is too weak.");
      } else {
        showMessage("Registration failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="register-card sales-register-card">
        <div className="sales-register-header">
          <h1>VaxTrack</h1>
          <p>Sales Representative Onboarding</p>
        </div>

        <h2 className="register-title">Sales Rep Sign Up</h2>
        <p className="brand-subtitle register-subtitle">
          Create an account for manager review and department assignment.
        </p>

        <form onSubmit={handleRegister} className="auth-form">
          <label>Full Name</label>
          <div className="input-group">
            <User size={18} />
            <input
              type="text"
              placeholder="e.g. Juan Dela Cruz"
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
                  placeholder="SR-2026-001"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label>Phone Number</label>
              <div className="input-group">
                <Phone size={18} />
                <input
                  type="text"
                  placeholder="09123456789"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                />
              </div>
            </div>
          </div>

          <label>Work Email</label>
          <div className="input-group">
            <Mail size={18} />
            <input
              type="email"
              placeholder="salesrep@vaxtrack.ph"
              value={workEmail}
              onChange={(e) => setWorkEmail(e.target.value)}
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
              "Submitting account..."
            ) : (
              <>
                Submit for Approval <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account?{" "}
          <button className="inline-link" onClick={() => navigate("/")}>
            Log in →
          </button>
        </p>
      </div>
    </div>
  );
}

export default SalesRepRegister;