import { useEffect, useState } from "react";
import { nextManilaMidnightMs } from "../services/dispatchEligibility";

/**
 * The current time, refreshed at each 00:00 Asia/Manila.
 *
 * Dispatch eligibility only changes at Manila midnight, so a page that keeps
 * this value re-partitions its queue exactly then: an order scheduled for
 * today moves from Upcoming to the actionable queue without a reload and
 * without any server-side scheduled job. The rules still decide; this only
 * keeps the screen honest.
 */
export default function useManilaDayNow() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // +1s so the timer never fires a hair before the boundary.
    const delay = Math.max(1000, nextManilaMidnightMs(now) - Date.now() + 1000);
    const timer = window.setTimeout(() => setNow(new Date()), delay);
    return () => window.clearTimeout(timer);
  }, [now]);

  return now;
}
