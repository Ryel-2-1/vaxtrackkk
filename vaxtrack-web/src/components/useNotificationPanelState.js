import { useEffect, useState } from "react";
import { cleanDismissedIds, loadDismissedIds, notificationPanelKey, saveDismissedIds } from "../services/notificationPanelState";

/** Private browser preferences, separate from shared alert and read records. */
export default function useNotificationPanelState({ projectId, role, uid }) {
  const scope = notificationPanelKey(projectId, role, uid);
  const fresh = () => ({ scope, ids: loadDismissedIds(projectId, role, uid), undo: [] });
  const [saved, setSaved] = useState(fresh);
  const state = saved.scope === scope ? saved : fresh();

  useEffect(() => {
    if (saved.scope === scope) saveDismissedIds(projectId, role, uid, saved.ids);
  }, [projectId, role, uid, scope, saved]);

  const dismiss = (ids) => setSaved((current) => {
    const previous = current.scope === scope ? current : fresh();
    const added = cleanDismissedIds(ids).filter((id) => !previous.ids.includes(id));
    return { scope, ids: cleanDismissedIds([...previous.ids, ...added]), undo: added };
  });
  const undo = () => setSaved((current) => current.scope === scope
    ? { scope, ids: current.ids.filter((id) => !current.undo.includes(id)), undo: [] }
    : fresh());

  return { dismissedIds: state.ids, dismiss, undo, canUndo: state.undo.length > 0 };
}
