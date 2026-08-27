import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:geolocator/geolocator.dart';

class LocationService {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  // --- Foreground continuous-tracking config (MVP, in_transit only) ---
  // Only emit a new position after the rider has moved ~30 m, and never
  // write to Firestore more often than every 15 s. Both guards stack so a
  // stationary or jittery GPS cannot hammer Firestore.
  static const int _distanceFilterMeters = 30;
  static const Duration _minWriteInterval = Duration(seconds: 15);

  StreamSubscription<Position>? _trackSub;
  DateTime? _lastWriteAt;

  // Coalescing guard for offline resilience. At most one Firestore location
  // write may be in flight at a time. While one is pending (offline, its Future
  // does not complete until reconnection), later ticks do NOT queue — instead
  // the newest captured position is retained in [_pendingLatest] and written
  // ONCE after the in-flight write completes. This bounds the offline queue and
  // lets the freshest fix follow it, without replaying intermediate points.
  bool _writeInFlight = false;
  Position? _pendingLatest;

  bool get isTracking => _trackSub != null;

  Future<bool> requestPermission() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) return false;

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) return false;
    }
    if (permission == LocationPermission.deniedForever) return false;

    return true;
  }

  Future<Position?> getCurrentPosition() async {
    final hasPermission = await requestPermission();
    if (!hasPermission) return null;

    return await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
    );
  }

  Future<void> updateRiderLocation(String riderId, Position position) {
    return _db.collection('users').doc(riderId).update({
      'lastLocation': GeoPoint(position.latitude, position.longitude),
      'lastLocationUpdate': FieldValue.serverTimestamp(),
    });
  }

  Future<void> updateOrderLocation(String orderId, Position position) {
    return _db.collection('orders').doc(orderId).update({
      'lastLocation': GeoPoint(position.latitude, position.longitude),
      'lastLocationUpdate': FieldValue.serverTimestamp(),
    });
  }

  /// Start foreground-only continuous tracking for [riderId].
  ///
  /// Each accepted (throttled) position tick is written to every order the
  /// rider currently has in `in_transit`, plus the rider's own `users/{uid}`
  /// doc. Safe to call repeatedly — any existing subscription is cancelled
  /// first so only one stream is ever live. Returns `true` if the stream
  /// started; `false` if permission/location services were unavailable
  /// (the caller decides how to surface that — tracking simply doesn't start).
  ///
  /// Background execution is intentionally out of scope: the OS suspends this
  /// stream when the app is backgrounded/killed. This is the documented MVP.
  Future<bool> startTracking(String riderId) async {
    await stopTracking();

    final hasPermission = await requestPermission();
    if (!hasPermission) return false;

    _trackSub = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: _distanceFilterMeters,
      ),
    ).listen(
      (pos) => _handleTick(riderId, pos),
      onError: (_) {}, // never crash the rider app on a GPS error
      cancelOnError: false,
    );
    return true;
  }

  /// Stop tracking and release the stream subscription. Idempotent.
  Future<void> stopTracking() async {
    await _trackSub?.cancel();
    _trackSub = null;
    _lastWriteAt = null;
    _writeInFlight = false;
    _pendingLatest = null;
  }

  Future<void> _handleTick(String riderId, Position pos) async {
    // Coalesce while a write is in flight: keep ONLY the newest captured
    // position and return. It is flushed once the in-flight write completes.
    // This is an in-memory replacement (no Firestore write, no throttle), so a
    // long offline period never accumulates a backlog of stale points — the
    // older retained fix is simply overwritten by the newer one.
    if (_writeInFlight) {
      _pendingLatest = pos;
      return;
    }

    // Not in flight: apply the 15 s time throttle on top of the stream's 30 m
    // distance filter, then write this position.
    final now = DateTime.now();
    if (_lastWriteAt != null &&
        now.difference(_lastWriteAt!) < _minWriteInterval) {
      return;
    }
    _lastWriteAt = now;
    await _writePosition(riderId, pos);
  }

  /// Write a single [pos] to every in_transit order for [riderId] plus the
  /// rider's own `users/{uid}` doc. Bounds the offline queue: only one such
  /// write is ever in flight, and when it completes the newest position
  /// captured meanwhile (if any) is flushed exactly once. This does NOT
  /// guarantee zero stale writes — a fix already queued offline still commits
  /// with its original capture time — but the backlog is bounded to that one
  /// write, immediately followed by the freshest retained fix.
  Future<void> _writePosition(String riderId, Position pos) async {
    _writeInFlight = true;

    final data = <String, dynamic>{
      'lastLocation': GeoPoint(pos.latitude, pos.longitude),
      // Stamp the actual GPS fix time, NOT a server timestamp. If this write is
      // queued offline and commits later, the position is still labelled with
      // when it was captured — so an old fix is never presented as "live now"
      // and the web staleness badge stays correct.
      'lastLocationUpdate': Timestamp.fromDate(pos.timestamp),
      'locationAccuracy': pos.accuracy,
      'heading': pos.heading,
      'speed': pos.speed,
    };

    try {
      // Fetch by rider only (single-field equality — no composite index),
      // then filter to in_transit client-side, matching how the rest of the
      // app queries. Write the same position to every in_transit order.
      final snap = await _db
          .collection('orders')
          .where('assignedRiderId', isEqualTo: riderId)
          .get();

      for (final doc in snap.docs) {
        if ((doc.data()['status'] as String?) == 'in_transit') {
          await doc.reference.update(data);
        }
      }

      // Rider-level "last seen", once per accepted write.
      await _db.collection('users').doc(riderId).update(data);
    } catch (_) {
      // Swallow write errors: a dropped write must never break tracking or the
      // rider's status flow. The next accepted tick will retry.
    } finally {
      // Reached once the writes are server-confirmed (or errored). While offline
      // the awaits above stay pending and this does NOT run — which is exactly
      // what bounds the queue to a single in-flight write.
      _writeInFlight = false;

      // Flush the newest position captured while this write was in flight, once,
      // if tracking is still active. All intermediate offline points were only
      // ever held in memory (overwritten) and are discarded here.
      final retained = _pendingLatest;
      _pendingLatest = null;
      if (retained != null && isTracking) {
        _lastWriteAt = DateTime.now();
        unawaited(_writePosition(riderId, retained));
      }
    }
  }

  double distanceBetween(
    double startLat,
    double startLng,
    double endLat,
    double endLng,
  ) {
    return Geolocator.distanceBetween(startLat, startLng, endLat, endLng);
  }
}
