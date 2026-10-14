import { useState } from "react";
import { applyLatest, editedFields, staleFields } from "../services/liveFormSync";

/**
 * An edit form that follows live data without ever overwriting what the user
 * typed.
 *
 *   - While the form is clean, it simply follows the server.
 *   - Once the user has edited it, a server change is NOT applied; the fields
 *     that changed are reported as `stale` and the caller blocks saving until
 *     the user chooses `loadLatest()` (those fields only — other edits kept)
 *     or `keepMine()` (an explicit decision to save their version anyway).
 *   - `gone` is true when the record no longer exists (server === null).
 *
 * `server` is a plain object of the editable fields as stored now, or null.
 */
export function useLiveDraft(server) {
  const serverKey = server === null ? "\u0000gone" : JSON.stringify(server);
  const [draft, setDraft] = useState(server ?? {});
  const [baseline, setBaseline] = useState(server ?? {});
  const [seenKey, setSeenKey] = useState(serverKey);
  const dirty = editedFields(draft, baseline).length > 0;

  // A newer server value arrived: adopt it while the form is clean. This is
  // React's "adjust state when a prop changes" pattern (guarded, in render),
  // not an effect, so there is no flash of the old value.
  if (seenKey !== serverKey) {
    setSeenKey(serverKey);
    if (!dirty && server) {
      setDraft(server);
      setBaseline(server);
    }
  }

  const stale = dirty && server ? staleFields(baseline, server) : [];
  return {
    draft,
    setDraft,
    setField: (field, value) => setDraft((prev) => ({ ...prev, [field]: value })),
    dirty,
    stale,
    gone: server === null,
    /** Load the latest stored value into the stale fields; keep the rest. */
    loadLatest: () => {
      if (!server) return;
      setDraft((prev) => applyLatest(prev, server, staleFields(baseline, server)));
      setBaseline(server);
    },
    /** Keep the typed values; the user has seen the newer ones. */
    keepMine: () => {
      if (server) setBaseline(server);
    },
    /**
     * After THIS form's own successful save: the saved values become the
     * baseline, so the snapshot that echoes the save is not reported as a
     * change made elsewhere.
     */
    markSaved: (saved) => {
      setDraft(saved);
      setBaseline(saved);
      // The echo may already have arrived (stored in its normalised form):
      // forget it, so the now-clean form adopts whatever is stored.
      setSeenKey(null);
    },
    /** Discard edits and follow the server again. */
    reset: () => {
      if (server) {
        setDraft(server);
        setBaseline(server);
      }
    },
  };
}
