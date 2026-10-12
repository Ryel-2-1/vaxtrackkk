// onSnapshot, made to recover: same call shape — (ref, onNext, onError) —
// same unsubscribe. A transient failure re-opens the listener after a short
// backoff (the page keeps its last data meanwhile); anything else reaches
// onError exactly as before. See liveConnection.js for the rules.

import { onSnapshot } from "firebase/firestore";
import { createRecoveringListener } from "./liveConnection.js";

export function listenLive(ref, onNext, onError) {
  return createRecoveringListener({
    attach: (next, error) => onSnapshot(ref, next, error),
    onNext,
    onError,
  });
}
