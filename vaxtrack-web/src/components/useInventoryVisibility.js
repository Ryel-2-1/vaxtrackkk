import { useEffect, useMemo, useState } from "react";
import { inactiveProductIds } from "../services/inventoryVisibility";

/** Re-evaluate while a list stays open, and when returning to the tab. No writes/reads. */
export function useInventoryVisibility(vaccines, rawInventory) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return useMemo(() => inactiveProductIds(vaccines, rawInventory, now), [vaccines, rawInventory, now]);
}
