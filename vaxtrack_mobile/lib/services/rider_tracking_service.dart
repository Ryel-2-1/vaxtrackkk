import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';

import '../models/delivery.dart';
import '../tracking/location_write_policy.dart';
import '../tracking/rider_tracking_controller.dart';
import '../tracking/tracking_contract.dart';
import '../tracking/tracking_lifecycle.dart';
import 'delivery_service.dart';

/// Real device location via Geolocator.
///
/// ANDROID: the fix stream runs as Geolocator's foreground service with a
/// visible, ongoing "Sharing location for delivery" notification, so tracking
/// continues with the screen locked or the app in the background (it stops if
/// the app is force-closed). Requires the FOREGROUND_SERVICE,
/// FOREGROUND_SERVICE_LOCATION and POST_NOTIFICATIONS permissions declared in
/// AndroidManifest.xml. ACCESS_BACKGROUND_LOCATION is deliberately NOT used:
/// the service is started while the app is in use.
///
/// iOS: foreground only (no UIBackgroundModes location is declared).
class GeolocatorLocationSource implements TrackingLocationSource {
  @override
  Future<LocationAccess> checkAccess() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return LocationAccess.serviceDisabled;
      return _map(await Geolocator.checkPermission());
    } catch (_) {
      return LocationAccess.denied;
    }
  }

  @override
  Future<LocationAccess> requestAccess() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return LocationAccess.serviceDisabled;
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      final access = _map(permission);
      if (access == LocationAccess.granted) {
        // Android 13+: the tracking notification needs this to be visible.
        await NotificationPermission.request();
      }
      return access;
    } catch (_) {
      return LocationAccess.denied;
    }
  }

  static LocationAccess _map(LocationPermission p) {
    switch (p) {
      case LocationPermission.always:
      case LocationPermission.whileInUse:
        return LocationAccess.granted;
      case LocationPermission.deniedForever:
        return LocationAccess.deniedForever;
      case LocationPermission.denied:
      case LocationPermission.unableToDetermine:
        return LocationAccess.denied;
    }
  }

  @override
  Stream<LocationFix> fixes(TrackingMode mode) {
    final navigating = mode == TrackingMode.navigating;
    final LocationSettings settings;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      settings = AndroidSettings(
        accuracy: navigating ? LocationAccuracy.high : LocationAccuracy.medium,
        // No distance filter: a stationary rider must still produce fixes, or
        // the write policy's heartbeat never fires and an assigned rider who
        // is waiting would read Stale/Offline. The interval bounds frequency
        // and the write policy filters jitter and throttles writes.
        distanceFilter: 0,
        intervalDuration: Duration(seconds: navigating ? 5 : 15),
        foregroundNotificationConfig: ForegroundNotificationConfig(
          notificationTitle: 'VaxTrack: sharing location for delivery',
          notificationText: navigating
              ? 'Navigating an active delivery. Stops automatically when your deliveries end.'
              : 'Active delivery assigned. Stops automatically when your deliveries end.',
          notificationChannelName: 'Delivery location sharing',
          setOngoing: true,
          enableWakeLock: navigating,
        ),
      );
    } else {
      settings = LocationSettings(
        accuracy: navigating ? LocationAccuracy.high : LocationAccuracy.medium,
        distanceFilter: 0,
      );
    }
    return Geolocator.getPositionStream(locationSettings: settings).map(
      (p) => LocationFix(
        latitude: p.latitude,
        longitude: p.longitude,
        accuracyMeters: p.accuracy,
        headingDegrees: p.heading,
        speedMps: p.speed,
        capturedAt: p.timestamp,
      ),
    );
  }

  @override
  Future<bool> notificationsAllowed() => NotificationPermission.isGranted();

  @override
  Future<void> openAppSettings() async {
    await Geolocator.openAppSettings();
  }

  @override
  Future<void> openLocationSettings() async {
    await Geolocator.openLocationSettings();
  }
}

/// Android 13+ notification permission via a tiny platform channel in
/// MainActivity.kt (no extra package). Missing channel (tests, iOS) = no-op.
class NotificationPermission {
  static const MethodChannel _channel = MethodChannel('vaxtrack/notification_permission');

  static Future<bool> isGranted() async {
    try {
      return (await _channel.invokeMethod<String>('status')) == 'granted';
    } on MissingPluginException {
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> request() async {
    try {
      return (await _channel.invokeMethod<String>('request')) == 'granted';
    } on MissingPluginException {
      return true;
    } catch (_) {
      return false;
    }
  }
}

/// Firestore persistence, field-for-field what firestore.rules accept.
class FirestoreTrackingStore implements TrackingStore {
  FirestoreTrackingStore({FirebaseFirestore? firestore}) : _injected = firestore;
  final FirebaseFirestore? _injected;
  FirebaseFirestore get _db => _injected ?? FirebaseFirestore.instance;

  DocumentReference<Map<String, dynamic>> _location(String uid) =>
      _db.collection(kRiderLocationsCollection).doc(uid);
  DocumentReference<Map<String, dynamic>> _session(String uid) =>
      _db.collection(kNavigationSessionsCollection).doc(uid);

  @override
  Future<void> writeLocation({
    required String riderUid,
    required LocationFix fix,
    String? activeOrderId,
    String? navigationSessionId,
  }) {
    return _location(riderUid).set({
      'riderUid': riderUid,
      'latitude': fix.latitude,
      'longitude': fix.longitude,
      'accuracyMeters': fix.accuracyMeters,
      'headingDegrees': fix.sanitizedHeading,
      'speedMps': fix.sanitizedSpeed,
      // When the fix was taken (an old fix arriving late is shown as old)...
      'capturedAt': Timestamp.fromDate(fix.capturedAt),
      // ...and when the server accepted it.
      'updatedAt': FieldValue.serverTimestamp(),
      'trackingState': 'active',
      'activeOrderId': activeOrderId,
      'navigationSessionId': navigationSessionId,
      'source': kLocationSource,
      'schemaVersion': kLocationSchemaVersion,
    });
  }

  @override
  Future<void> writeEnded({required String riderUid, required DateTime at}) {
    return _location(riderUid).set({
      'riderUid': riderUid,
      'latitude': null,
      'longitude': null,
      'accuracyMeters': null,
      'headingDegrees': null,
      'speedMps': null,
      'capturedAt': Timestamp.fromDate(at),
      'updatedAt': FieldValue.serverTimestamp(),
      'trackingState': 'ended',
      'activeOrderId': null,
      'navigationSessionId': null,
      'source': kLocationSource,
      'schemaVersion': kLocationSchemaVersion,
    });
  }

  @override
  Future<void> startSession({
    required String riderUid,
    required String orderId,
    required String sessionId,
  }) {
    return _session(riderUid).set({
      'riderUid': riderUid,
      'orderId': orderId,
      'sessionId': sessionId,
      'state': 'navigating',
      'startedAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
      'endedAt': null,
      'endReason': null,
    });
  }

  @override
  Future<void> endSession({
    required String riderUid,
    required String sessionId,
    required String reason,
  }) {
    final ref = _session(riderUid);
    return _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      final data = snap.data();
      // Only the CURRENT, still-navigating session is ended here; the server
      // may already have ended it (order completed / reassigned).
      if (data == null || data['state'] != 'navigating' || data['sessionId'] != sessionId) return;
      tx.update(ref, {
        'state': 'ended',
        'endReason': reason,
        'endedAt': FieldValue.serverTimestamp(),
        'updatedAt': FieldValue.serverTimestamp(),
      });
    });
  }

  /// The server's deviation state for the rider (own doc only — rules).
  Stream<Map<String, dynamic>?> deviationState(String riderUid) => _db
      .collection(kDeviationStatesCollection)
      .doc(riderUid)
      .snapshots()
      .map((s) => s.data());
}

/// The rider's live orders, as the controller needs them.
Stream<List<TrackedOrder>> trackedOrdersFor(String riderUid, {DeliveryService? service}) {
  return (service ?? DeliveryService()).riderDeliveries(riderUid).map(
        (list) => list
            .map((Delivery d) => TrackedOrder(id: d.id, status: d.status, assignedRiderId: d.assignedRiderId))
            .toList(),
      );
}

/// The single app-wide controller (attached by HomeScreen, shut down on sign-out).
final RiderTrackingController riderTracking = RiderTrackingController(
  source: GeolocatorLocationSource(),
  store: FirestoreTrackingStore(),
);
