"use strict";

/**
 * Rider push notifications — sending (decisions in riderPush.js).
 *
 * riderPushTokens/{riderUid} { riderUid, tokens: [≤ 5 FCM tokens], updatedAt }
 * is written by the Rider app itself (firestore.rules: own document only) and
 * read here. A token FCM reports as gone is removed. A push is best effort:
 * a failure is logged by type and never retried (the trigger does not retry),
 * so a Rider is never told the same thing twice. The order itself is always
 * the source of truth in the app.
 */

const { riderNotificationsFor, DEAD_TOKEN_CODES, TOKENS_COLLECTION } = require("./riderPush");

async function notifyRiderOnOrderWrite({ db, messaging, FieldValue, orderId, before, after, log = () => {} }) {
  const notes = riderNotificationsFor(before, after);
  const results = [];
  for (const note of notes) {
    const ref = db.collection(TOKENS_COLLECTION).doc(note.riderUid);
    const snap = await ref.get();
    const tokens = (snap.exists ? snap.get("tokens") : null);
    const list = Array.isArray(tokens) ? tokens.filter((t) => typeof t === "string" && t.length > 0) : [];
    if (list.length === 0) {
      results.push({ kind: note.kind, sent: 0, reason: "no-device" });
      continue;
    }
    const response = await messaging.sendEachForMulticast({
      tokens: list,
      notification: { title: note.title, body: note.body },
      data: { orderId: String(orderId), kind: note.kind },
      android: {
        priority: "high",
        // One notification per order and event: a repeat replaces it.
        notification: { tag: `${note.kind}_${orderId}` },
      },
    });
    const dead = [];
    response.responses.forEach((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.includes(r.error?.code)) dead.push(list[i]);
      else if (!r.success) log({ kind: note.kind, errorCode: r.error?.code ?? "unknown" });
    });
    if (dead.length > 0) await ref.update({ tokens: FieldValue.arrayRemove(...dead) });
    results.push({ kind: note.kind, sent: response.successCount, removed: dead.length });
  }
  return results;
}

module.exports = { notifyRiderOnOrderWrite };
