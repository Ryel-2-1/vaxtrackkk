import { EyeOff, Lock, Mail, Truck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./Rider.css";

function GoogleIcon() {
  return (
    <svg className="rider-google-icon" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.8-3.4-11.3-8.1l-6.5 5C9.5 39.5 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C36.9 39.3 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

function RiderLogin() {
  const navigate = useNavigate();

  return (
    <main className="rider-auth-page">
      <section className="rider-auth-wrap">
        <div className="rider-logo-box">
          <div className="rider-logo-icon">
            <Truck size={26} />
          </div>
          <h1>VaxTrack</h1>
          <p>Medical Logistics Portal</p>
        </div>

        <div className="rider-auth-card">
          <div className="rider-field">
            <label>Rider ID or Email</label>
            <div className="rider-input">
              <Mail size={16} />
              <input placeholder="Enter your ID or email" />
            </div>
          </div>

          <div className="rider-field">
            <label>Password</label>
            <div className="rider-input">
              <Lock size={16} />
              <input type="password" placeholder="Enter your password" />
              <EyeOff size={16} />
            </div>
          </div>

          <div className="rider-auth-row">
            <label>
              <input type="checkbox" />
              Remember me
            </label>

            <button
              type="button"
              className="rider-auth-link"
              onClick={() => navigate("/rider/forgot-password")}
            >
              Forgot Password?
            </button>
          </div>

          <button
            type="button"
            className="rider-primary-btn"
            onClick={() => navigate("/rider")}
          >
            Login →
          </button>

          <div className="rider-divider">or</div>

          <button type="button" className="rider-outline-btn">
            <GoogleIcon />
              Continue with Google
          </button>
        </div>

        <div className="rider-auth-bottom">
          <p>New to VaxTrack?</p>
          <button
            type="button"
            className="rider-secondary-btn"
            onClick={() => navigate("/rider/register")}
          >
            Create Account
          </button>
        </div>
      </section>
    </main>
  );
}

export default RiderLogin;