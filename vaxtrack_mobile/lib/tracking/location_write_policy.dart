import 'dart:math' as math;

/// How actively the rider is being tracked.
///
///  * [off]        no eligible active delivery — nothing is sent;
///  * [tracking]   at least one active delivery — balanced, infrequent writes;
///  * [navigating] Start Navigation for one order — frequent writes, so the
///                 server's 3-minute deviation rule always has fresh samples.
enum TrackingMode { off, tracking, navigating }

/// One GPS fix, reduced to what the tracking contract stores.
class LocationFix {
  final double latitude;
  final double longitude;
  final double accuracyMeters;
  final double? headingDegrees;
  final double? speedMps;
  final DateTime capturedAt;

  const LocationFix({
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    required this.capturedAt,
    this.headingDegrees,
    this.speedMps,
  });

  /// Heading/speed exactly as the rules accept them, or null when the device
  /// did not supply a usable value (Geolocator reports unknown as -1 / 0).
  double? get sanitizedHeading {
    final h = headingDegrees;
    if (h == null || !h.isFinite || h < 0 || h > 360) return null;
    return h;
  }

  double? get sanitizedSpeed {
    final s = speedMps;
    if (s == null || !s.isFinite || s < 0 || s > 100) return null;
    return s;
  }
}

/// Write cadence for one mode.
class WriteCadence {
  /// Never write more often than this.
  final Duration minInterval;

  /// Write at least this often while the fix stream continues, even when the
  /// rider is stationary (keeps the location fresh and the server's
  /// continuity check satisfied while navigating).
  final Duration heartbeat;

  /// Movement smaller than this (or than the fix's own accuracy) is GPS jitter.
  final double minDistanceMeters;

  const WriteCadence({
    required this.minInterval,
    required this.heartbeat,
    required this.minDistanceMeters,
  });
}

/// Battery vs freshness. Navigating writes are frequent enough that the
/// server never sees a gap > 2 minutes (its continuity limit); idle tracking
/// writes rarely and only on real movement.
const Map<TrackingMode, WriteCadence> kWriteCadence = {
  TrackingMode.tracking: WriteCadence(
    minInterval: Duration(seconds: 30),
    heartbeat: Duration(minutes: 2),
    minDistanceMeters: 50,
  ),
  TrackingMode.navigating: WriteCadence(
    minInterval: Duration(seconds: 10),
    heartbeat: Duration(seconds: 30),
    minDistanceMeters: 20,
  ),
};

/// A fix this inaccurate is not worth storing at all.
const double kMaxWriteAccuracyMeters = 200;

/// Why a fix was (not) written. Diagnostics and tests.
enum WriteReason {
  first,
  moved,
  heartbeat,
  modeChanged,
  notTracking,
  invalidCoordinates,
  poorAccuracy,
  outOfOrder,
  tooSoon,
  jitter,
}

class WriteDecision {
  final bool write;
  final WriteReason reason;
  const WriteDecision(this.write, this.reason);
}

/// Pure write throttle. Decides whether ONE fix should be written, given the
/// last WRITTEN fix. Repeated callbacks, older (out-of-order) fixes, GPS jitter
/// and invalid readings never produce a write.
class LocationWritePolicy {
  LocationFix? _lastWritten;
  TrackingMode? _lastMode;

  LocationFix? get lastWritten => _lastWritten;

  /// Forget the last write (e.g. after tracking stopped).
  void reset() {
    _lastWritten = null;
    _lastMode = null;
  }

  WriteDecision decide(LocationFix fix, TrackingMode mode) {
    if (mode == TrackingMode.off) {
      return const WriteDecision(false, WriteReason.notTracking);
    }
    if (!isValidCoordinate(fix.latitude, fix.longitude)) {
      return const WriteDecision(false, WriteReason.invalidCoordinates);
    }
    final acc = fix.accuracyMeters;
    if (!acc.isFinite || acc < 0 || acc > kMaxWriteAccuracyMeters) {
      return const WriteDecision(false, WriteReason.poorAccuracy);
    }
    final last = _lastWritten;
    if (last == null) return const WriteDecision(true, WriteReason.first);
    if (!fix.capturedAt.isAfter(last.capturedAt)) {
      return const WriteDecision(false, WriteReason.outOfOrder);
    }
    final cadence = kWriteCadence[mode]!;
    final elapsed = fix.capturedAt.difference(last.capturedAt);
    if (_lastMode != mode) {
      // Switching tracking <-> navigating publishes the new state promptly,
      // but still never faster than the stricter minimum interval.
      if (elapsed >= kWriteCadence[TrackingMode.navigating]!.minInterval) {
        return const WriteDecision(true, WriteReason.modeChanged);
      }
      return const WriteDecision(false, WriteReason.tooSoon);
    }
    if (elapsed < cadence.minInterval) {
      return const WriteDecision(false, WriteReason.tooSoon);
    }
    if (elapsed >= cadence.heartbeat) {
      return const WriteDecision(true, WriteReason.heartbeat);
    }
    final moved = distanceMeters(
      last.latitude,
      last.longitude,
      fix.latitude,
      fix.longitude,
    );
    // Movement within the combined uncertainty of the two fixes is jitter.
    final threshold = math.max(
      cadence.minDistanceMeters,
      math.max(fix.accuracyMeters, last.accuracyMeters),
    );
    if (moved < threshold) return const WriteDecision(false, WriteReason.jitter);
    return const WriteDecision(true, WriteReason.moved);
  }

  /// Record that [fix] was written in [mode].
  void markWritten(LocationFix fix, TrackingMode mode) {
    _lastWritten = fix;
    _lastMode = mode;
  }
}

/// Same validity rule as the server: in range, finite, and not (0, 0).
bool isValidCoordinate(double lat, double lng) {
  return lat.isFinite &&
      lng.isFinite &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180 &&
      !(lat == 0 && lng == 0);
}

/// Great-circle distance in metres.
double distanceMeters(double lat1, double lng1, double lat2, double lng2) {
  const r = 6371008.8;
  const deg = math.pi / 180;
  final dLat = (lat2 - lat1) * deg;
  final dLng = (lng2 - lng1) * deg;
  final h = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(lat1 * deg) *
          math.cos(lat2 * deg) *
          math.sin(dLng / 2) *
          math.sin(dLng / 2);
  return 2 * r * math.asin(math.min(1.0, math.sqrt(h)));
}
