import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Lock,
  Mail,
  ShieldCheck,
} from "lucide-react";
import "./Auth.css";

function ForgotPassword() {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");

  const handleEmailSubmit = (e) => {
    e.preventDefault();
    setError("");

    if (!email.trim()) {
      setError("Please enter your registered email address.");
      return;
    }

    setStep("otp");
  };

  const handleOtpChange = (index, value) => {
    if (!/^\d?$/.test(value)) return;

    const updatedOtp = [...otp];
    updatedOtp[index] = value;
    setOtp(updatedOtp);

    const nextInput = document.getElementById(`otp-${index + 1}`);
    if (value && nextInput) {
      nextInput.focus();
    }
  };

  const handleOtpSubmit = (e) => {
    e.preventDefault();
    setError("");

    if (otp.join("").length !== 6) {
      setError("Please enter the 6-digit verification code.");
      return;
    }

    setStep("reset");
  };

  const handleResetSubmit = (e) => {
    e.preventDefault();
    setError("");

    if (!newPassword || !confirmPassword) {
      setError("Please fill in both password fields.");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setStep("success");
  };

  return (
    <div className="auth-page forgot-page">
      {step === "email" && (
        <div className="auth-card forgot-card">
          <div className="auth-brand forgot-brand">
            <h1>VaxTrack Admin</h1>
            <p>Forgot Password</p>
          </div>

          <form className="auth-form" onSubmit={handleEmailSubmit}>
            <h2 className="forgot-title">Reset Password</h2>
            <p className="forgot-subtitle">
              Enter your registered email and we will send you a verification
              code.
            </p>

            <label>Email Address</label>
            <div className="auth-input">
              <Mail size={16} />
              <input
                type="email"
                placeholder="admin@vaxtrack.ph"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {error && <div className="auth-error">{error}</div>}

            <button className="primary-auth-btn" type="submit">
              Send Verification Code
              <ArrowRight size={16} />
            </button>

            <Link to="/" className="back-login-link">
              <ArrowLeft size={14} />
              Back to Login
            </Link>
          </form>
        </div>
      )}

      {step === "otp" && (
        <div className="auth-card forgot-card">
          <div className="auth-brand forgot-brand">
            <h1>VaxTrack</h1>
            <p>Admin Security</p>
          </div>

          <form className="auth-form" onSubmit={handleOtpSubmit}>
            <div className="forgot-icon-box">
              <ShieldCheck size={24} />
            </div>

            <h2 className="forgot-title">Verify Identity</h2>
            <p className="forgot-subtitle">
              Enter the 6-digit code sent to your registered email address.
            </p>

            <div className="otp-row">
              {otp.map((digit, index) => (
                <input
                  key={index}
                  id={`otp-${index}`}
                  maxLength="1"
                  value={digit}
                  onChange={(e) => handleOtpChange(index, e.target.value)}
                />
              ))}
            </div>

            <button type="button" className="resend-code-btn">
              Resend Code
            </button>

            {error && <div className="auth-error">{error}</div>}

            <button className="primary-auth-btn" type="submit">
              Verify Code
              <ArrowRight size={16} />
            </button>

            <div className="forgot-help-box">
              <strong>Need Assistance?</strong>
              <p>
                Contact your system administrator if you no longer have access
                to your registered email.
              </p>
            </div>
          </form>
        </div>
      )}

      {step === "reset" && (
        <div className="auth-card forgot-card">
          <div className="auth-brand forgot-brand">
            <h1>VaxTrack Admin</h1>
            <p>Create New Password</p>
          </div>

          <form className="auth-form" onSubmit={handleResetSubmit}>
            <h2 className="forgot-title">Set New Password</h2>
            <p className="forgot-subtitle">
              Choose a strong password to secure your administrator account.
            </p>

            <label>New Password</label>
            <div className="auth-input">
              <Lock size={16} />
              <input
                type={showNewPassword ? "text" : "password"}
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <button
                type="button"
                className="icon-ghost"
                onClick={() => setShowNewPassword((prev) => !prev)}
              >
                {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <label>Confirm Password</label>
            <div className="auth-input">
              <Lock size={16} />
              <input
                type={showConfirmPassword ? "text" : "password"}
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              <button
                type="button"
                className="icon-ghost"
                onClick={() => setShowConfirmPassword((prev) => !prev)}
              >
                {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <div className="password-rules">
              <p>At least 8 characters</p>
              <p>Include one number or symbol</p>
              <p>Avoid using old passwords</p>
            </div>

            {error && <div className="auth-error">{error}</div>}

            <button className="primary-auth-btn" type="submit">
              Reset Password
              <ArrowRight size={16} />
            </button>

            <button
              type="button"
              className="back-login-link reset-back-btn"
              onClick={() => setStep("otp")}
            >
              <ArrowLeft size={14} />
              Back to Verification
            </button>
          </form>
        </div>
      )}

      {step === "success" && (
        <div className="auth-card forgot-card success-card">
          <div className="success-icon">
            <CheckCircle2 size={28} />
          </div>

          <h2>Password Reset Successful</h2>

          <p>
            Your administrator password has been updated successfully. You can
            now sign in using your new password.
          </p>

          <Link to="/" className="primary-auth-btn success-login-btn">
            Back to Login
            <ArrowRight size={16} />
          </Link>

          <small>
            You will be redirected to the login page for security verification.
          </small>
        </div>
      )}
    </div>
  );
}

export default ForgotPassword;