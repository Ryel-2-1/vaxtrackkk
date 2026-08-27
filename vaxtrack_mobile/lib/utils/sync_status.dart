/// Sync state derived from Firestore snapshot metadata, surfaced to the rider
/// as a small, honest indicator.
///
/// This is deliberately NOT an "online / offline" signal. Firestore serves
/// cached data even while the device is perfectly reachable, so `isFromCache`
/// alone must never be shown as "Offline" — it only means the rider is looking
/// at previously-loaded (saved) data that has not yet been re-confirmed by the
/// server in this session.
enum SyncStatus {
  /// The snapshot was confirmed by the Firestore backend.
  synced,

  /// The snapshot came from the local cache (previously-loaded data).
  cached,

  /// A local write has not yet reached the server (offline or in-flight).
  pending,
}

/// Map raw snapshot metadata flags to a [SyncStatus].
///
/// Precedence matters:
///  * [hasPendingWrites] wins first — an unsynced local write is the most
///    important thing to show honestly (Firestore also marks such a snapshot
///    as coming from cache, so this must be checked before [isFromCache]).
///  * otherwise [isFromCache] → [SyncStatus.cached].
///  * otherwise → [SyncStatus.synced].
SyncStatus syncStatusFrom({
  required bool hasPendingWrites,
  required bool isFromCache,
}) {
  if (hasPendingWrites) return SyncStatus.pending;
  if (isFromCache) return SyncStatus.cached;
  return SyncStatus.synced;
}

extension SyncStatusDisplay on SyncStatus {
  /// Short label for the indicator chip.
  String get label {
    switch (this) {
      case SyncStatus.synced:
        return 'Synced';
      case SyncStatus.cached:
        return 'Cached data';
      case SyncStatus.pending:
        return 'Pending sync';
    }
  }
}
