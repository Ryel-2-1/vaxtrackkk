import { useCallback, useEffect, useState } from "react";
import { subscribeAllDeviationStates, subscribeAllRiderLocations } from "../../services/riderTrackingService";

/**
 * Every rider's current location and server deviation state, keyed by rider
 * uid — the Admin / Dispatcher live-tracking reads (firestore.rules allow
 * them to those roles only). Shared by Live Tracking and the Dispatcher
 * dashboard overview so both use the same subscriptions.
 *
 * Returns:
 *   locations       null until the first snapshot, then { [uid]: doc }
 *   deviations      { [uid]: doc } (empty until loaded or on failure)
 *   error           null | "permission" | "error"   (locations feed)
 *   deviationError  true when only the deviation feed failed (positions stay live)
 *   retry()         re-subscribe after an error
 *
 * Read-only: nothing here writes.
 */
export default function useRiderTrackingFeeds() {
  const [attempt, setAttempt] = useState(0);
  const [locations, setLocations] = useState(null);
  const [deviations, setDeviations] = useState({});
  const [error, setError] = useState(null);
  const [deviationError, setDeviationError] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubs = [
      subscribeAllRiderLocations(
        (data) => {
          if (!active) return;
          setLocations(data);
          setError(null);
        },
        (err) => active && setError(err?.code === "permission-denied" ? "permission" : "error"),
      ),
      // Deviation state enriches markers; its failure must not blank the map.
      subscribeAllDeviationStates(
        (data) => {
          if (!active) return;
          setDeviations(data);
          setDeviationError(false);
        },
        () => active && setDeviationError(true),
      ),
    ];
    return () => {
      active = false;
      unsubs.forEach((u) => typeof u === "function" && u());
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setError(null);
    setLocations(null);
    setAttempt((n) => n + 1);
  }, []);

  return { locations, deviations, error, deviationError, retry };
}
