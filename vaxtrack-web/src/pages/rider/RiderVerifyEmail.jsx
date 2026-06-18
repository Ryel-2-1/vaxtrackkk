import { ArrowLeft, MailCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./Rider.css";

function RiderVerifyEmail() {
  const navigate = useNavigate();

  return (
    <main className="rider-auth-page">
      <section className="rider-auth-wrap verify-wrap">
        <button
          type="button"
          className="verify-back"
          onClick={() => navigate("/rider/forgot-password")}
        >
          <ArrowLeft size={18} />
        </button>

        <div className="verify-content">
          <div className="forgot-icon">
            <MailCheck size={24} />
          </div>

          <h1>Verify Email</h1>
          <p>Enter the 6-digit verification code sent to your registered rider email address.</p>

          <div className="otp-row">
            <input defaultValue="8" />
            <input defaultValue="2" />
            <input defaultValue="0" />
            <input placeholder="-" />
            <input placeholder="-" />
            <input placeholder="-" />
          </div>

          <small>
            Didn't receive the code? <b>Resend in 45s</b>
          </small>
        </div>

        <button
          type="button"
          className="rider-primary-btn verify-btn"
          onClick={() => navigate("/rider/reset-password")}
        >
          Verify Code →
        </button>
      </section>
    </main>
  );
}

export default RiderVerifyEmail;