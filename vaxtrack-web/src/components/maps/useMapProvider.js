import { useCallback, useState } from "react";
import { currentMapProvider } from "../../services/mapProvider";

/**
 * For a map drawn on Google Maps with an OpenStreetMap safety net: returns
 * [useGoogle, onUnavailable]. The provider is read once per mount; calling
 * onUnavailable (Google failed to load or refused the key) switches this map
 * to OpenStreetMap for the rest of its life.
 */
export default function useMapProvider() {
  const [provider] = useState(currentMapProvider);
  const [failed, setFailed] = useState(false);
  const onUnavailable = useCallback(() => setFailed(true), []);
  return [provider === "google" && !failed, onUnavailable];
}
