import { useCallback, useEffect, useRef, useState } from "react";
import { TOAST_DURATION_MS, normalizeTone } from "./feedbackModel";

/**
 * One toast at a time per page. `showToast(text, tone)`; success and info
 * clear themselves after a readable delay, errors stay until dismissed.
 * Render it with <ToastRegion toast={toast} onDismiss={dismissToast} />.
 */
export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const seq = useRef(0);

  const dismissToast = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);

  const showToast = useCallback((text, tone = "success") => {
    clearTimeout(timer.current);
    if (!text) {
      setToast(null);
      return;
    }
    const t = normalizeTone(tone);
    seq.current += 1;
    setToast({ text, tone: t, key: seq.current });
    const ms = TOAST_DURATION_MS[t];
    if (ms) timer.current = setTimeout(() => setToast(null), ms);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { toast, showToast, dismissToast };
}
