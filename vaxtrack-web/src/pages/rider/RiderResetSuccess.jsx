import { CheckCircle2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./Rider.css";

function RiderResetSuccess() {
  const navigate = useNavigate();

  return (
    <main className="rider-auth-page">
      <section className="rider-auth-wrap reset-success-wrap">
        <div className="reset-success-content">
          <div className="rider-success-circle small">
            <CheckCircle2 size={36} />
          </div>

          <h1>Password Reset Successful</h1>
          <p>
            Your account is secure. You can now use your new password to log in
            and access the dashboard.
          </p>
        </div>

        <button
          type="button"
          className="rider-primary-btn"
          onClick={() => navigate("/rider/login")}
        >
          Back to Login
        </button>
      </section>
    </main>
  );
}

export default RiderResetSuccess;