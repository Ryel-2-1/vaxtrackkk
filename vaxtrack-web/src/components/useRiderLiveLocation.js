import { useEffect, useState } from "react";
import { subscribeRiderDeviationState, subscribeRiderLocation } from "../services/riderTrackingService";

// How often "fresh / stale / offline" is re-evaluated without a new fix.
export const FRESHNESS_TICK_MS = 30 * 1000;

/** A clock that re-renders every FRESHNESS_TICK_MS so ages stay honest. */
export function useNow(intervalMs = FRESHNESS_TICK_MS) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * One rider's live location (riderLocations/{uid}) and — for Admin/Dispatcher
 * only — their server deviation state. Subscribes only while `enabled` (the
 * order is still tracked); otherwise nothing is read.
 *
 * status: "idle" (disabled / no rider) | "loading" | "ready" | "denied" | "error".
 * "denied" is a normal outcome for a Med Rep whose access ended (the order was
 * delivered or reassigned) — the UI shows Location Unavailable, not an error.
 */
export function useRiderLiveLocation(riderUid, { enabled = true, withDeviation = false } = {}) {
  const active = Boolean(enabled && typeof riderUid === "string" && riderUid);
  const key = active ? `${riderUid}|${withDeviation}` : null;
  const [state, setState] = useState({ key: null, status: "idle", location: null, deviation: null });

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    const update = (patch) => {
      if (!cancelled) setState((prev) => ({ ...(prev.key === key ? prev : { location: null, deviation: null }), key, ...patch }));
    };
    const failed = (err) => update({ status: err?.code === "permission-denied" ? "denied" : "error", location: null });
    const unsubs = [subscribeRiderLocation(riderUid, (location) => update({ status: "ready", location }), failed)];
    if (withDeviation) {
      // A deviation-state failure must not hide the position: keep it null.
      unsubs.push(subscribeRiderDeviationState(riderUid, (deviation) => update({ deviation }), () => update({ deviation: null })));
    }
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [key, riderUid, withDeviation]);

  if (!key) return { status: "idle", location: null, deviation: null };
  if (state.key !== key) return { status: "loading", location: null, deviation: null };
  return { status: state.status === "idle" ? "loading" : state.status, location: state.location, deviation: state.deviation };
}
