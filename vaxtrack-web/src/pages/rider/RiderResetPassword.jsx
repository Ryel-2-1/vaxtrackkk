import { ArrowLeft, EyeOff, Lock, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./Rider.css";

function RiderResetPassword() {
  const navigate = useNavigate();

  return (
    <main className="rider-auth-page">
      <section className="rider-auth-wrap reset-wrap">
        <button
          type="button"
          className="verify-back"
          onClick={() => navigate("/rider/verify-email")}
        >
          <ArrowLeft size={18} />
        </button>

        <div className="reset-header">
          <div className="forgot-icon">
            <RotateCcw size={22} />
          </div>

          <h1>Set New Password</h1>
          <p>Your new password must be different from previously used passwords to ensure account security.</p>
        </div>

        <div className="rider-field">
          <label>New Password</label>
          <div className="rider-input">
            <Lock size={16} />
            <input type="password" placeholder="Enter new password" />
            <EyeOff size={16} />
          </div>
        </div>

        <div className="password-strength">
          <div className="strength-bars">
            <span></span>
            <span></span>
            <span></span>
            <span className="muted"></span>
            <span className="muted"></span>
          </div>

          <ul>
            <li>At least 8 characters</li>
            <li>Contains a number</li>
            <li>Contains a special character</li>
          </ul>
        </div>

        <div className="rider-field">
          <label>Confirm New Password</label>
          <div className="rider-input">
            <Lock size={16} />
            <input type="password" placeholder="Re-enter new password" />
            <EyeOff size={16} />
          </div>
        </div>

        <button
          type="button"
          className="rider-primary-btn reset-submit"
          onClick={() => navigate("/rider/reset-success")}
        >
          Reset Password
        </button>
      </section>
    </main>
  );
}

export default RiderResetPassword;