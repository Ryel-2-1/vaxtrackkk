/// Confirming navigation fixes (functions/src/riderTracking.js, CONFIRMED
/// CONTINUITY; firestore.rules isNavigationFixConfirmation).
///
/// After a fix tagged with the navigation session has been STORED, the app
/// writes that fix's server write time to its session document as
/// `lastNavigationFixAt`. The rules accept the value only when it equals the
/// stored location's `updatedAt` (pinned to the server clock) and the stored
/// fix qualifies, so the app never chooses the time — it only passes on the
/// one the server assigned. Firestore commits one client's writes in order, so
/// the confirmation is stored before any later location write of the app.
library;

import 'tracking_contract.dart';

/// The rider's location document as stored, read back after the write.
class StoredFix {
  /// Capture time as stored — identifies which write this is.
  final DateTime capturedAt;

  /// Server write time, or null while the server has not assigned it.
  final DateTime? updatedAt;

  /// The `updatedAt` value exactly as stored (a Firestore Timestamp), sent
  /// back unchanged so no precision is lost.
  final Object? rawUpdatedAt;

  final String? navigationSessionId;
  final String? activeOrderId;

  const StoredFix({
    required this.capturedAt,
    required this.updatedAt,
    required this.rawUpdatedAt,
    required this.navigationSessionId,
    required this.activeOrderId,
  });
}

/// Does a stored tagged fix qualify for confirmation? Mirrors the server's
/// sampleFromLocation and the rules: real coordinates (not 0,0), accuracy
/// known and at most [kDeviationMaxAccuracyMeters], stored no more than
/// [kMaxFixAgeSeconds] after capture, tagged with a session and its order.
bool navigationFixQualifies({
  required String? navigationSessionId,
  required String? activeOrderId,
  required double latitude,
  required double longitude,
  required double accuracyMeters,
  required DateTime capturedAt,
  required DateTime? storedAt,
}) {
  if (navigationSessionId == null || navigationSessionId.isEmpty) return false;
  if (activeOrderId == null || activeOrderId.isEmpty) return false;
  if (!latitude.isFinite || !longitude.isFinite) return false;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  if (latitude == 0 && longitude == 0) return false;
  if (!accuracyMeters.isFinite || accuracyMeters < 0 || accuracyMeters > kDeviationMaxAccuracyMeters) return false;
  if (storedAt == null) return false;
  return storedAt.difference(capturedAt) <= const Duration(seconds: kMaxFixAgeSeconds);
}

/// After a location write has been acknowledged: confirm it on the session
/// when it is a qualifying fix of that session.
///
/// [readStored] reads the location document back (from the local cache — the
/// acknowledged write carries the server's updatedAt). [send] enqueues the
/// confirmation write; it is called synchronously, before this returns, so it
/// is queued ahead of the next location write. Never throws: a confirmation
/// that cannot be made only leaves the server with the evidence it already
/// has, it never stops location sharing.
Future<bool> confirmStoredNavigationFix({
  required String? navigationSessionId,
  required String? activeOrderId,
  required double latitude,
  required double longitude,
  required double accuracyMeters,
  required DateTime capturedAt,
  required Future<StoredFix?> Function() readStored,
  required void Function(Object rawUpdatedAt) send,
}) async {
  if (navigationSessionId == null || activeOrderId == null) return false;
  try {
    final stored = await readStored();
    if (stored == null || stored.rawUpdatedAt == null) return false;
    // Only the write just made: another write (a second device, a newer fix)
    // must never be confirmed in its place.
    if (!stored.capturedAt.isAtSameMomentAs(capturedAt) ||
        stored.navigationSessionId != navigationSessionId ||
        stored.activeOrderId != activeOrderId) {
      return false;
    }
    if (!navigationFixQualifies(
      navigationSessionId: navigationSessionId,
      activeOrderId: activeOrderId,
      latitude: latitude,
      longitude: longitude,
      accuracyMeters: accuracyMeters,
      capturedAt: capturedAt,
      storedAt: stored.updatedAt,
    )) {
      return false;
    }
    send(stored.rawUpdatedAt!);
    return true;
  } catch (_) {
    return false;
  }
}
