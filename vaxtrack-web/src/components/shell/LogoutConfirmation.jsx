import { signOut } from "firebase/auth";
import { auth } from "../../firebase";
import ConfirmDialog from "../ui/ConfirmDialog";
import DialogLayer from "../ui/DialogLayer";

export default function LogoutConfirmation({ onCancel, onSignedOut }) {
  return (
    <DialogLayer>
      <ConfirmDialog
        title="Are you sure you want to log out?"
        target={auth.currentUser?.email}
        consequence="You’ll need to sign in again to access VaxTrack."
        confirmLabel="Log out"
        busyLabel="Logging out…"
        failureMessage="Couldn’t log you out. Please try again."
        onCancel={onCancel}
        onConfirm={async () => {
          await signOut(auth);
          onCancel();
          onSignedOut?.();
        }}
      />
    </DialogLayer>
  );
}
