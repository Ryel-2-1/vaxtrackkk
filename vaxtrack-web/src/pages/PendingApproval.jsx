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
          reviewed by a manager or administrator before you can access the Sales
          Pro Dashboard.
        </p>

        <div className="pending-note">
          <ShieldCheck size={20} />
          <span>
            Once approved, your role will be updated to <b>sales_rep</b> and
            your department will be assigned to <b>sales</b>.
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