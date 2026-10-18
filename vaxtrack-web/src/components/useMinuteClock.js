import { useEffect, useState } from "react";

/**
 * The viewer's clock, refreshed each minute. Display wording only ("delayed
 * by N minutes") — never a basis for a timing decision, which is the
 * server's (functions/src/deliveryTiming.js).
 */
export default function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  return now;
}
