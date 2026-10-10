import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/tracking/location_write_policy.dart';

// ~111 m per 0.001° of latitude.
LocationFix fix(int seconds, {double lat = 14.6, double lng = 121.0, double acc = 10}) => LocationFix(
      latitude: lat,
      longitude: lng,
      accuracyMeters: acc,
      capturedAt: DateTime.utc(2026, 10, 1, 8).add(Duration(seconds: seconds)),
    );

void main() {
  group('LocationWritePolicy', () {
    late LocationWritePolicy policy;
    setUp(() => policy = LocationWritePolicy());

    WriteDecision writeIfAllowed(LocationFix f, TrackingMode mode) {
      final d = policy.decide(f, mode);
      if (d.write) policy.markWritten(f, mode);
      return d;
    }

    test('writes the first valid fix', () {
      expect(writeIfAllowed(fix(0), TrackingMode.tracking).reason, WriteReason.first);
    });

    test('never writes while tracking is off', () {
      expect(policy.decide(fix(0), TrackingMode.off).write, isFalse);
    });

    test('rejects invalid coordinates, including (0, 0)', () {
      expect(policy.decide(fix(0, lat: 0, lng: 0), TrackingMode.tracking).reason, WriteReason.invalidCoordinates);
      expect(policy.decide(fix(0, lat: 91), TrackingMode.tracking).reason, WriteReason.invalidCoordinates);
      expect(policy.decide(fix(0, lng: double.nan), TrackingMode.tracking).reason, WriteReason.invalidCoordinates);
    });

    test('rejects fixes worse than the maximum write accuracy', () {
      expect(policy.decide(fix(0, acc: kMaxWriteAccuracyMeters + 1), TrackingMode.tracking).reason,
          WriteReason.poorAccuracy);
      expect(policy.decide(fix(0, acc: double.infinity), TrackingMode.tracking).reason, WriteReason.poorAccuracy);
    });

    test('drops repeated and out-of-order fixes', () {
      writeIfAllowed(fix(100), TrackingMode.tracking);
      expect(policy.decide(fix(100, lat: 14.7), TrackingMode.tracking).reason, WriteReason.outOfOrder);
      expect(policy.decide(fix(50, lat: 14.7), TrackingMode.tracking).reason, WriteReason.outOfOrder);
    });

    test('throttles writes to the minimum interval', () {
      writeIfAllowed(fix(0), TrackingMode.tracking);
      expect(policy.decide(fix(29, lat: 14.61), TrackingMode.tracking).reason, WriteReason.tooSoon);
      expect(policy.decide(fix(31, lat: 14.61), TrackingMode.tracking).reason, WriteReason.moved);
    });

    test('treats movement inside GPS uncertainty as jitter', () {
      writeIfAllowed(fix(0, acc: 80), TrackingMode.tracking);
      // ~55 m: above the 50 m minimum but inside the 80 m accuracy.
      expect(policy.decide(fix(40, lat: 14.6005, acc: 80), TrackingMode.tracking).reason, WriteReason.jitter);
      // ~111 m: real movement.
      expect(policy.decide(fix(40, lat: 14.601, acc: 80), TrackingMode.tracking).reason, WriteReason.moved);
    });

    test('heartbeat keeps a stationary rider fresh', () {
      writeIfAllowed(fix(0), TrackingMode.tracking);
      expect(policy.decide(fix(119), TrackingMode.tracking).write, isFalse);
      expect(policy.decide(fix(120), TrackingMode.tracking).reason, WriteReason.heartbeat);
    });

    test('navigating writes often enough for the server continuity rule (< 120 s gap)', () {
      final nav = kWriteCadence[TrackingMode.navigating]!;
      expect(nav.heartbeat, lessThan(const Duration(seconds: 120)));
      writeIfAllowed(fix(0), TrackingMode.navigating);
      expect(policy.decide(fix(30), TrackingMode.navigating).reason, WriteReason.heartbeat);
    });

    test('a mode change publishes promptly but not faster than 10 s', () {
      writeIfAllowed(fix(0), TrackingMode.tracking);
      expect(policy.decide(fix(5), TrackingMode.navigating).reason, WriteReason.tooSoon);
      expect(policy.decide(fix(10), TrackingMode.navigating).reason, WriteReason.modeChanged);
    });

    test('reset forgets the last write', () {
      writeIfAllowed(fix(100), TrackingMode.tracking);
      policy.reset();
      expect(policy.decide(fix(50), TrackingMode.tracking).reason, WriteReason.first);
    });
  });

  group('LocationFix sanitizing', () {
    LocationFix withHs(double? h, double? s) => LocationFix(
          latitude: 14.6,
          longitude: 121,
          accuracyMeters: 5,
          capturedAt: DateTime.utc(2026),
          headingDegrees: h,
          speedMps: s,
        );

    test('unknown heading/speed become null (rules accept null or a range)', () {
      expect(withHs(-1, -1).sanitizedHeading, isNull);
      expect(withHs(-1, -1).sanitizedSpeed, isNull);
      expect(withHs(400, 150).sanitizedHeading, isNull);
      expect(withHs(400, 150).sanitizedSpeed, isNull);
      expect(withHs(double.nan, double.nan).sanitizedSpeed, isNull);
      expect(withHs(90, 12).sanitizedHeading, 90);
      expect(withHs(90, 12).sanitizedSpeed, 12);
    });
  });
}
