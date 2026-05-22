import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { Lock, Mail, Eye, EyeOff, ArrowRight } from "lucide-react";
import { auth, db } from "../firebase";

function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("admin@vaxtrack.com");
  const [password, setPassword] = useState("admin123");
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");

  const showMessage = (text, type = "error") => {
    setMessage(text);
    setMessageType(type);
  };

  const validateForm = () => {
    if (!email.trim()) {
      showMessage("Email is required.");
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

    return true;
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setMessage("");
    setMessageType("");

    if (!validateForm()) return;

    setLoading(true);

    try {
      const userCredential = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );

      const uid = userCredential.user.uid;
      const userRef = doc(db, "users", uid);
      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {
        showMessage(
          "Login successful, but no role record was found in Firestore. Please check the users collection."
        );
        setLoading(false);
        return;
      }

      const userData = userSnap.data();

      showMessage("Login successful. Redirecting...", "success");

      setTimeout(() => {
      if (userData.status === "pending" || userData.role === "pending") {
  navigate("/pending");
} else if (userData.role === "admin") {
  navigate("/admin");
} else if (
  userData.role === "sales_rep" &&
  userData.department === "sales" &&
  userData.status === "approved"
) {
  navigate("/sales");
} else if (userData.role === "rider") {
  setError("Rider accounts should use the mobile app.");
} else {
  setError("Invalid role or account access is not yet approved.");
}
      }, 700);
    } catch (err) {
      console.error(err);

      if (err.code === "auth/user-not-found") {
        showMessage("No account found with this email.");
      } else if (err.code === "auth/wrong-password") {
        showMessage("Incorrect password. Please try again.");
      } else if (err.code === "auth/invalid-email") {
        showMessage("Invalid email format.");
      } else if (err.code === "auth/too-many-requests") {
        showMessage("Too many failed attempts. Please try again later.");
      } else if (err.code === "auth/invalid-credential") {
        showMessage("Invalid email or password.");
      } else {
       showMessage(`Login failed: ${err.code}`, "error");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setMessage("");
    setMessageType("");

    if (!email.trim()) {
      showMessage("Enter your email first before resetting your password.");
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email.trim());
      showMessage("Password reset email sent. Please check your inbox.", "success");
    } catch (err) {
      console.error(err);
      showMessage("Unable to send password reset email.");
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card refined-auth-card">
        <div className="auth-logo">
          <div className="logo-circle">
            <span className="dot dot-yellow"></span>
            <span className="dot dot-orange"></span>
            <span className="dot dot-red"></span>
          </div>
        </div>

        <h1 className="brand-title">VaxTrack Portal</h1>
        <p className="brand-subtitle">
          Authorized access for logistics staff and riders
        </p>

        <form onSubmit={handleLogin} className="auth-form">
          <label>Email or Employee ID</label>
          <div className="input-group">
            <Mail size={18} />
            <input
              type="email"
              placeholder="e.g. admin@vaxtrack.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="label-row">
            <label>Password</label>
            <button
              type="button"
              className="link-button"
              onClick={handleForgotPassword}
            >
              Forgot Password?
            </button>
          </div>

          <div className="input-group">
            <Lock size={18} />
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <button
              type="button"
              className="icon-button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label="Toggle password visibility"
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          <label className="remember-row">
            <input type="checkbox" />
            <span>Remember me</span>
          </label>

          {message && (
            <p className={`form-message ${messageType}`}>
              {message}
            </p>
          )}

          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? (
              "Verifying account..."
            ) : (
              <>
                Login to Portal <ArrowRight size={16} />
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
          Sign in with Google
        </button>

        <p className="auth-footer">
  Don&apos;t have an Account?{" "}
  <button className="inline-link" onClick={() => navigate("/register")}>
    Register here →
  </button>
</p>

<p className="auth-footer">
  Applying as Sales Rep?{" "}
  <button className="inline-link" onClick={() => navigate("/sales-register")}>
    Create sales account →
  </button>
</p>

        <p className="copyright">
          © 2026 VaxTrack Philippines Medical Logistics.
          <br />
          Authorized Access Only.
        </p>
      </div>
    </div>
  );
}

export default Login;