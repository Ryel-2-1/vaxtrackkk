import 'dart:ui' show AppLifecycleState;

import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:vaxtrack_mobile/services/rider_tracking_service.dart';
import 'package:vaxtrack_mobile/tracking/location_write_policy.dart';
import 'package:vaxtrack_mobile/tracking/tracking_lifecycle.dart';

// The Android location request, and the lifecycle mapping HomeScreen uses.
// Locked-screen evidence (vivo V2419): general tracking stopped writing while
// locked because it ran WITHOUT the foreground service's wake lock.

void main() {
  group('androidTrackingSettings', () {
    for (final mode in [TrackingMode.tracking, TrackingMode.navigating]) {
      test('$mode: foreground service, visible ongoing notification, wake lock', () {
        final s = androidTrackingSettings(mode);
        final n = s.foregroundNotificationConfig;
        expect(n, isNotNull, reason: 'runs as the foreground location service');
        expect(n!.enableWakeLock, isTrue, reason: 'the CPU stays available while the screen is locked');
        expect(n.setOngoing, isTrue);
        expect(n.notificationTitle, 'VaxTrack: sharing location for delivery');
        expect(n.enableWifiLock, isFalse);
        expect(s.distanceFilter, 0, reason: 'a stationary rider still produces heartbeat fixes');
      });
    }

    test('general tracking stays the battery-friendly request', () {
      final s = androidTrackingSettings(TrackingMode.tracking);
      expect(s.accuracy, LocationAccuracy.medium);
      expect(s.intervalDuration, const Duration(seconds: 15));
    });

    test('navigation keeps the precise request', () {
      final s = androidTrackingSettings(TrackingMode.navigating);
      expect(s.accuracy, LocationAccuracy.high);
      expect(s.intervalDuration, const Duration(seconds: 5));
    });
  });

  test('the wake lock does not change how often anything is written', () {
    final tracking = kWriteCadence[TrackingMode.tracking]!;
    final navigating = kWriteCadence[TrackingMode.navigating]!;
    expect([tracking.minInterval, tracking.heartbeat, tracking.minDistanceMeters],
        [const Duration(seconds: 30), const Duration(minutes: 2), 50]);
    expect([navigating.minInterval, navigating.heartbeat, navigating.minDistanceMeters],
        [const Duration(seconds: 10), const Duration(seconds: 30), 20]);
  });

  test('lifecycle: only resumed and paused/hidden change anything; none cancels a stream', () {
    expect(foregroundForLifecycle(AppLifecycleState.resumed), isTrue);
    expect(foregroundForLifecycle(AppLifecycleState.paused), isFalse);
    expect(foregroundForLifecycle(AppLifecycleState.hidden), isFalse);
    expect(foregroundForLifecycle(AppLifecycleState.inactive), isNull);
    expect(foregroundForLifecycle(AppLifecycleState.detached), isNull);
  });
}
