import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/sync_status.dart';

void main() {
  group('syncStatusFrom', () {
    test('server-confirmed snapshot -> synced', () {
      final status = syncStatusFrom(hasPendingWrites: false, isFromCache: false);
      expect(status, SyncStatus.synced);
      expect(status.label, 'Synced');
    });

    test('cache-only snapshot -> cached (never "offline")', () {
      final status = syncStatusFrom(hasPendingWrites: false, isFromCache: true);
      expect(status, SyncStatus.cached);
      expect(status.label, 'Cached data');
    });

    test('pending local write -> pending sync', () {
      final status = syncStatusFrom(hasPendingWrites: true, isFromCache: false);
      expect(status, SyncStatus.pending);
      expect(status.label, 'Pending sync');
    });

    test('pending write takes precedence over cache flag', () {
      // Firestore marks a pending-write snapshot as fromCache too; pending must
      // win so the rider sees the more important "not yet synced" state.
      final status = syncStatusFrom(hasPendingWrites: true, isFromCache: true);
      expect(status, SyncStatus.pending);
    });
  });
}
