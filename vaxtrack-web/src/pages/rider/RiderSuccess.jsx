import { CheckCircle2, Truck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./Rider.css";

function RiderSuccess() {
  const navigate = useNavigate();

  return (
    <main className="rider-auth-page">
      <section className="rider-success-wrap">
        <div className="rider-success-logo">
          <Truck size={14} /> VaxTrack
        </div>

        <div className="rider-success-hero">
          <div className="rider-success-circle">
            <CheckCircle2 size={56} />
          </div>
        </div>

        <div className="rider-success-card">
          <h1>Handa na, Partner!</h1>
          <p>
            Account Created! Welcome to VaxTrack. Your profile is being
            verified, but you can start exploring your dashboard now.
          </p>
        </div>

        <div className="rider-success-spacer"></div>

        <button
          type="button"
          className="rider-primary-btn"
          onClick={() => navigate("/rider")}
        >
          Go to Dashboard →
        </button>

        <p className="rider-success-footer">
          © 2026 VaxTrack Philippines • Secure Logistics
        </p>
      </section>
    </main>
  );
}

export default RiderSuccess;