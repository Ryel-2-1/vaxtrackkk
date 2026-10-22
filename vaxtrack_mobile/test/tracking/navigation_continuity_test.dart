import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/tracking/navigation_continuity.dart';
import 'package:vaxtrack_mobile/tracking/tracking_contract.dart';

/// Confirming a stored navigation fix (navigation_continuity.dart). The server
/// and firestore.rules decide; these pin the app to the same qualification and
/// to never confirming a write other than the one it just made.
void main() {
  final captured = DateTime.utc(2026, 10, 17, 2, 0, 0);
  const session = 'sess_cc000001';
  const order = 'orderNav';

  StoredFix stored({
    DateTime? capturedAt,
    Duration storedAfter = const Duration(seconds: 2),
    bool pending = false,
    String? sessionId = session,
    String? orderId = order,
  }) {
    final at = capturedAt ?? captured;
    final updated = pending ? null : captured.add(storedAfter);
    return StoredFix(
      capturedAt: at.toLocal(), // the cache returns local time: compared by instant
      updatedAt: updated,
      rawUpdatedAt: updated == null ? null : 'server:${updated.millisecondsSinceEpoch}',
      navigationSessionId: sessionId,
      activeOrderId: orderId,
    );
  }

  Future<(bool, List<Object>, int)> run({
    String? sessionId = session,
    String? orderId = order,
    double latitude = 14.6,
    double longitude = 121.0,
    double accuracy = 8,
    StoredFix? readBack,
    bool readThrows = false,
  }) async {
    final sent = <Object>[];
    var reads = 0;
    final ok = await confirmStoredNavigationFix(
      navigationSessionId: sessionId,
      activeOrderId: orderId,
      latitude: latitude,
      longitude: longitude,
      accuracyMeters: accuracy,
      capturedAt: captured,
      readStored: () async {
        reads += 1;
        if (readThrows) throw StateError('cache unavailable');
        return readBack ?? stored();
      },
      send: sent.add,
    );
    return (ok, sent, reads);
  }

  test('a qualifying tagged fix is confirmed with the server time exactly as stored', () async {
    final (ok, sent, _) = await run();
    expect(ok, isTrue);
    expect(sent, ['server:${captured.add(const Duration(seconds: 2)).millisecondsSinceEpoch}']);
  });

  test('ordinary (untagged) fixes are never confirmed and cost no read', () async {
    for (final (s, o) in [(null, order), (session, null), (null, null)]) {
      final (ok, sent, reads) = await run(sessionId: s, orderId: o);
      expect(ok, isFalse);
      expect(sent, isEmpty);
      expect(reads, 0);
    }
  });

  test('inaccurate, invalid or late-written fixes do not qualify', () async {
    for (final args in [
      {'accuracy': 101.0},
      {'accuracy': -1.0},
      {'accuracy': double.nan},
      {'latitude': 0.0, 'longitude': 0.0},
      {'latitude': 91.0},
    ]) {
      final (ok, sent, _) = await run(
        accuracy: (args['accuracy'] ?? 8.0),
        latitude: (args['latitude'] ?? 14.6),
        longitude: (args['longitude'] ?? 121.0),
      );
      expect(ok, isFalse, reason: '$args');
      expect(sent, isEmpty, reason: '$args');
    }
    // Stored 61 s after capture (a late offline write): refused; 60 s is fine.
    expect((await run(readBack: stored(storedAfter: const Duration(seconds: 61)))).$1, isFalse);
    expect((await run(readBack: stored(storedAfter: const Duration(seconds: 60)))).$1, isTrue);
    expect((await run(accuracy: kDeviationMaxAccuracyMeters.toDouble())).$1, isTrue);
  });

  test('only the write just made is confirmed — never another or a newer one', () async {
    final other = [
      stored(capturedAt: captured.add(const Duration(seconds: 5))), // a newer fix
      stored(sessionId: 'sess_cc000777'),
      stored(orderId: 'otherOrder'),
      stored(pending: true), // server time not known yet
    ];
    for (final s in other) {
      final (ok, sent, _) = await run(readBack: s);
      expect(ok, isFalse);
      expect(sent, isEmpty);
    }
  });

  test('a failed read never throws and sends nothing (location sharing is unaffected)', () async {
    final (ok, sent, _) = await run(readThrows: true);
    expect(ok, isFalse);
    expect(sent, isEmpty);
  });

  test('qualification mirrors the server contract', () {
    expect(kNavigationContinuityVersion, 1);
    expect(kMaxFixAgeSeconds, 60);
    bool q({double acc = 8, int ageSeconds = 1, String? s = session, String? o = order}) => navigationFixQualifies(
          navigationSessionId: s,
          activeOrderId: o,
          latitude: 14.6,
          longitude: 121.0,
          accuracyMeters: acc,
          capturedAt: captured,
          storedAt: captured.add(Duration(seconds: ageSeconds)),
        );
    expect([q(), q(acc: 100), q(acc: 100.5), q(ageSeconds: 60), q(ageSeconds: 61), q(s: ''), q(o: '')],
        [true, true, false, true, false, false, false]);
    // A device clock ahead of the server (capture "after" storage) still qualifies, as on the server.
    expect(q(ageSeconds: -30), isTrue);
  });
}
