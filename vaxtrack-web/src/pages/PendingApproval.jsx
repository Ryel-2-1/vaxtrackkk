import { useNavigate } from "react-router-dom";
import { Clock, LogOut, ShieldCheck } from "lucide-react";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";

function PendingApproval() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="auth-page">
      <div className="pending-card">
        <div className="pending-icon">
          <Clock size={42} />
        </div>

        <h1>Account Pending Approval</h1>

        <p>
          Your VaxTrack account has been created, but it still needs to be
          reviewed and approved by an administrator before you can access the
          portal.
        </p>

        <div className="pending-note">
          <ShieldCheck size={20} />
          <span>
            Once approved, you will be able to log in and access your assigned
            dashboard. You will receive access based on the role you applied for.
          </span>
        </div>

        <button className="primary-button" onClick={handleLogout}>
          <LogOut size={16} />
          Back to Login
        </button>
      </div>
    </div>
  );
}

export default PendingApproval;