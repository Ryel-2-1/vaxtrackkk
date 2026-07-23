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
  }

  Future<void> _handleTick(String riderId, Position pos) async {
    // Time-based throttle on top of the stream's distance filter.
    final now = DateTime.now();
    if (_lastWriteAt != null &&
        now.difference(_lastWriteAt!) < _minWriteInterval) {
      return;
    }
    _lastWriteAt = now;

    final data = <String, dynamic>{
      'lastLocation': GeoPoint(pos.latitude, pos.longitude),
      'lastLocationUpdate': FieldValue.serverTimestamp(),
      'locationAccuracy': pos.accuracy,
      'heading': pos.heading,
      'speed': pos.speed,
    };

    try {
      // Fetch by rider only (single-field equality — no composite index),
      // then filter to in_transit client-side, matching how the rest of the
      // app queries. Write the same tick to every in_transit order.
      final snap = await _db
          .collection('orders')
          .where('assignedRiderId', isEqualTo: riderId)
          .get();

      for (final doc in snap.docs) {
        if ((doc.data()['status'] as String?) == 'in_transit') {
          await doc.reference.update(data);
        }
      }

      // Rider-level "last seen", once per accepted tick.
      await _db.collection('users').doc(riderId).update(data);
    } catch (_) {
      // Swallow write errors: a dropped tick must never break tracking or
      // the rider's status flow. The next accepted tick will retry.
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
