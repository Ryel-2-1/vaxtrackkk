import { ArrowLeft, Mail, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./Rider.css";

function RiderForgotPassword() {
  const navigate = useNavigate();

  return (
    <main className="rider-auth-page">
      <section className="rider-auth-wrap forgot-wrap">
        <div className="forgot-card">
          <div className="forgot-icon">
            <RotateCcw size={22} />
          </div>

          <h1>Password Reset</h1>
          <p>Enter your registered email or Rider ID to receive a secure recovery code.</p>

          <div className="rider-field">
            <label>Email or Rider ID</label>
            <div className="rider-input">
              <Mail size={16} />
              <input placeholder="e.g. rider@vaxtrack.com or VT-1042" />
            </div>
          </div>

          <button
            type="button"
            className="rider-primary-btn"
            onClick={() => navigate("/rider/verify-email")}
          >
            Send Code
          </button>
        </div>

        <button
          type="button"
          className="back-login-btn"
          onClick={() => navigate("/rider/login")}
        >
          <ArrowLeft size={14} />
          Back to Login
        </button>
      </section>
    </main>
  );
}

export default RiderForgotPassword;