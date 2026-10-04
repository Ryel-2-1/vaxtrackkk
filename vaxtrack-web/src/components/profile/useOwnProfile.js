import { useEffect, useState } from "react";
import { auth } from "../../firebase";
import { subscribeOwnProfile } from "../../services/userService";

/**
 * The signed-in user's own users/{uid} document, kept live.
 *
 * Used by "My profile" and by each role's sidebar card, so a saved name shows
 * everywhere at once. State is written only from the subscription callbacks,
 * and the result is tagged with the uid it belongs to — a different signed-in
 * user never sees the previous one's profile, even for a frame.
 *
 * @returns {{uid: string|null, profile: object|null, loading: boolean, error: Error|null}}
 */
export default function useOwnProfile() {
  const uid = auth.currentUser?.uid ?? null;
  const [state, setState] = useState({ uid: null, profile: null, error: null });

  useEffect(() => {
    if (!uid) return undefined;
    return subscribeOwnProfile(
      uid,
      (profile) => setState({ uid, profile, error: null }),
      (error) => setState({ uid, profile: null, error })
    );
  }, [uid]);

  const current = state.uid === uid;
  return {
    uid,
    profile: current ? state.profile : null,
    loading: !!uid && !current,
    error: current ? state.error : null,
  };
}
