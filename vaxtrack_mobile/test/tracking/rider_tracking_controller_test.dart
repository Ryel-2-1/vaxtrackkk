import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/tracking/location_write_policy.dart';
import 'package:vaxtrack_mobile/tracking/rider_tracking_controller.dart';
import 'package:vaxtrack_mobile/tracking/tracking_contract.dart';
import 'package:vaxtrack_mobile/tracking/tracking_lifecycle.dart';

const rider = 'riderA';

class FakeSource implements TrackingLocationSource {
  LocationAccess access = LocationAccess.granted;
  LocationAccess onRequest = LocationAccess.granted;
  bool notifications = true;
  int requests = 0;
  final List<TrackingMode> streamsOpened = [];
  StreamController<LocationFix>? current;

  @override
  Future<LocationAccess> checkAccess() async => access;

  @override
  Future<LocationAccess> requestAccess() async {
    requests++;
    access = onRequest;
    return access;
  }

  @override
  Stream<LocationFix> fixes(TrackingMode mode) {
    streamsOpened.add(mode);
    current = StreamController<LocationFix>();
    return current!.stream;
  }

  bool get streaming => current != null && current!.hasListener;

  @override
  Future<bool> notificationsAllowed() async => notifications;

  @override
  Future<void> openAppSettings() async {}
  @override
  Future<void> openLocationSettings() async {}
}

class Write {
  final LocationFix fix;
  final String? orderId;
  final String? sessionId;
  Write(this.fix, this.orderId, this.sessionId);
}

class FakeStore implements TrackingStore {
  final List<Write> writes = [];
  final List<DateTime> ended = [];
  final List<(String, String)> started = [];
  final List<(String, String)> endedSessions = [];
  Completer<void>? hold; // when set, writeLocation waits (offline)
  bool failStart = false;

  @override
  Future<void> writeLocation({
    required String riderUid,
    required LocationFix fix,
    String? activeOrderId,
    String? navigationSessionId,
  }) async {
    writes.add(Write(fix, activeOrderId, navigationSessionId));
    if (hold != null) await hold!.future;
  }

  @override
  Future<void> writeEnded({required String riderUid, required DateTime at}) async => ended.add(at);

  @override
  Future<void> startSession({required String riderUid, required String orderId, required String sessionId}) async {
    if (failStart) throw StateError('offline');
    started.add((orderId, sessionId));
  }

  @override
  Future<void> endSession({required String riderUid, required String sessionId, required String reason}) async =>
      endedSessions.add((sessionId, reason));
}

final t0 = DateTime.utc(2026, 10, 1, 8);
LocationFix fix(int s, {double lat = 14.6, double acc = 10}) => LocationFix(
      latitude: lat,
      longitude: 121.0,
      accuracyMeters: acc,
      capturedAt: t0.add(Duration(seconds: s)),
    );
TrackedOrder order(String id, String status, {String to = rider}) =>
    TrackedOrder(id: id, status: status, assignedRiderId: to);

void main() {
  late FakeSource source;
  late FakeStore store;
  late RiderTrackingController c;
  late StreamController<List<TrackedOrder>> orders;

  setUp(() {
    source = FakeSource();
    store = FakeStore();
    c = RiderTrackingController(source: source, store: store, clock: () => t0.add(const Duration(hours: 1)));
    orders = StreamController<List<TrackedOrder>>();
    c.attach(rider, orders.stream);
  });

  Future<void> emit(List<TrackedOrder> list) async {
    orders.add(list);
    await pumpEventQueue();
    await c.idle;
  }

  Future<void> sendFix(LocationFix f) async {
    source.current!.add(f);
    await pumpEventQueue();
  }

  test('no active delivery: nothing is collected or written', () async {
    await emit([order('o1', 'delivered')]);
    expect(c.status, TrackingStatus.idle);
    expect(source.streamsOpened, isEmpty);
    expect(store.writes, isEmpty);
  });

  test('an assigned delivery starts tracking; the write carries no navigation fields', () async {
    await emit([order('o1', 'assigned')]);
    expect(c.status, TrackingStatus.tracking);
    expect(source.streamsOpened, [TrackingMode.tracking]);
    await sendFix(fix(0));
    expect(store.writes.single.orderId, isNull);
    expect(store.writes.single.sessionId, isNull);
  });

  test('delivery completed: stream stops and an ENDED state clears coordinates', () async {
    await emit([order('o1', 'in_transit')]);
    await sendFix(fix(0));
    await emit([order('o1', 'delivered')]);
    expect(c.status, TrackingStatus.idle);
    expect(source.streaming, isFalse);
    expect(store.ended, hasLength(1));
  });

  test('cancelled, failed and reassigned all stop tracking', () async {
    for (final next in [
      [order('o1', 'cancelled')],
      [order('o1', 'delivery_failed')],
      [order('o1', 'in_transit', to: 'riderB')],
      <TrackedOrder>[],
    ]) {
      await emit([order('o1', 'in_transit')]);
      expect(c.status, TrackingStatus.tracking);
      await emit(next);
      expect(c.status, TrackingStatus.idle);
      expect(source.streaming, isFalse);
    }
  });

  group('permissions', () {
    test('permission is never requested before the rider agrees', () async {
      source.access = LocationAccess.denied;
      await emit([order('o1', 'assigned')]);
      expect(c.status, TrackingStatus.needsPermission);
      expect(source.requests, 0);
      expect(source.streamsOpened, isEmpty);
    });

    test('declined → recoverable: asking again then granting starts tracking', () async {
      source.access = LocationAccess.denied;
      source.onRequest = LocationAccess.denied;
      await emit([order('o1', 'assigned')]);
      await c.allowLocation();
      expect(c.status, TrackingStatus.permissionDenied);
      source.onRequest = LocationAccess.granted;
      await c.allowLocation();
      expect(c.status, TrackingStatus.tracking);
      expect(source.streaming, isTrue);
    });

    test('blocked → settings → retry recovers', () async {
      source.access = LocationAccess.deniedForever;
      await emit([order('o1', 'assigned')]);
      expect(c.status, TrackingStatus.permissionBlocked);
      source.access = LocationAccess.granted; // the rider changed it in settings
      await c.retry();
      expect(c.status, TrackingStatus.tracking);
    });

    test('location services off → retry recovers', () async {
      source.access = LocationAccess.serviceDisabled;
      await emit([order('o1', 'assigned')]);
      expect(c.status, TrackingStatus.locationOff);
      source.access = LocationAccess.granted;
      await c.retry();
      expect(c.status, TrackingStatus.tracking);
    });

    test('a stream error surfaces as a retryable error', () async {
      await emit([order('o1', 'assigned')]);
      source.current!.addError(StateError('gps'));
      await pumpEventQueue();
      expect(c.status, TrackingStatus.error);
      await c.retry();
      expect(c.status, TrackingStatus.tracking);
      expect(source.streamsOpened, hasLength(2));
    });
  });

  group('navigation', () {
    test('start is refused before in transit and does not open a session', () async {
      await emit([order('o1', 'assigned')]);
      final error = await c.startNavigation('o1');
      expect(error, 'Navigation starts once the delivery is in transit.');
      expect(store.started, isEmpty);
    });

    test('start opens a session and switches to navigating; writes carry the session', () async {
      await emit([order('o1', 'in_transit')]);
      expect(await c.startNavigation('o1'), isNull);
      expect(c.status, TrackingStatus.navigating);
      expect(store.started.single.$1, 'o1');
      expect(source.streamsOpened.last, TrackingMode.navigating);
      await sendFix(fix(0));
      expect(store.writes.last.orderId, 'o1');
      expect(store.writes.last.sessionId, store.started.single.$2);
    });

    test('a failed session start leaves tracking unchanged', () async {
      await emit([order('o1', 'in_transit')]);
      store.failStart = true;
      expect(await c.startNavigation('o1'), isNotNull);
      expect(c.navigation, isNull);
      expect(c.status, TrackingStatus.tracking);
    });

    test('starting another order replaces the route (one session per rider)', () async {
      await emit([order('o1', 'in_transit'), order('o2', 'in_transit')]);
      await c.startNavigation('o1');
      final first = c.navigation!.sessionId;
      await c.startNavigation('o2');
      expect(c.navigation!.orderId, 'o2');
      expect(c.navigation!.sessionId, isNot(first));
      expect(store.started.map((s) => s.$1), ['o1', 'o2']);
    });

    test('starting the same order twice is a no-op', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1');
      await c.startNavigation('o1');
      expect(store.started, hasLength(1));
    });

    test('Stop ends the session as rider_stopped and keeps tracking', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1');
      final sid = c.navigation!.sessionId;
      await c.stopNavigation();
      expect(store.endedSessions.single, (sid, kEndReasonRiderStopped));
      expect(c.status, TrackingStatus.tracking);
    });

    test('the navigated order completing ends the session', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1');
      await emit([order('o1', 'delivered')]);
      expect(store.endedSessions.single.$2, kEndReasonTrackingStopped);
      expect(c.navigation, isNull);
      expect(c.status, TrackingStatus.idle);
    });
  });

  test('sign-out ends navigation and tracking and clears coordinates', () async {
    await emit([order('o1', 'in_transit')]);
    await c.startNavigation('o1');
    await sendFix(fix(0));
    await c.shutdown(reason: kEndReasonSignedOut);
    expect(store.endedSessions.single.$2, kEndReasonSignedOut);
    expect(store.ended, hasLength(1));
    expect(source.streaming, isFalse);
    expect(c.status, TrackingStatus.idle);
    // Later order snapshots are no longer followed.
    expect(orders.hasListener, isFalse);
  });

  group('app in the background (Android cannot start location services there)', () {
    test('a delivery that becomes active in the background waits for the app; nothing is collected', () async {
      await c.setForeground(false);
      await emit([order('o1', 'assigned')]);
      expect(c.status, TrackingStatus.waitingForApp);
      expect(source.streamsOpened, isEmpty);
      expect(store.writes, isEmpty);
      await c.setForeground(true);
      expect(c.status, TrackingStatus.tracking);
      expect(source.streamsOpened, [TrackingMode.tracking]);
    });

    test('sharing started in the foreground keeps running in the background', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1');
      await c.setForeground(false);
      expect(source.streaming, isTrue);
      await sendFix(fix(0));
      expect(store.writes, hasLength(1));
      // Navigation ends while backgrounded: the running stream is NOT restarted
      // (that would be a background start); cadence follows the new mode.
      await c.stopNavigation();
      expect(source.streamsOpened, [TrackingMode.tracking, TrackingMode.navigating]);
      expect(c.status, TrackingStatus.tracking);
      expect(source.streaming, isTrue);
    });

    test('the last delivery ending in the background still stops sharing and clears the position', () async {
      await emit([order('o1', 'in_transit')]);
      await c.setForeground(false);
      await emit([order('o1', 'delivered')]);
      expect(source.streaming, isFalse);
      expect(store.ended, hasLength(1));
    });
  });

  test('notifications off: sharing continues and the rider is told the notification is hidden', () async {
    source.notifications = false;
    await emit([order('o1', 'assigned')]);
    expect(c.status, TrackingStatus.tracking);
    expect(c.notificationsAllowed, isFalse);
    source.notifications = true;
    await c.retry();
    expect(c.notificationsAllowed, isTrue);
  });

  group('write coalescing', () {
    test('offline: one write in flight, only the NEWEST fix waits behind it', () async {
      await emit([order('o1', 'in_transit')]);
      store.hold = Completer<void>();
      await sendFix(fix(0));
      await sendFix(fix(40, lat: 14.61));
      await sendFix(fix(80, lat: 14.62));
      await sendFix(fix(120, lat: 14.63));
      expect(store.writes, hasLength(1));
      store.hold!.complete();
      store.hold = null;
      await pumpEventQueue();
      expect(store.writes, hasLength(2));
      expect(store.writes.last.fix.latitude, 14.63);
    });

    test('out-of-order and jittery fixes are not written', () async {
      await emit([order('o1', 'in_transit')]);
      await sendFix(fix(100));
      await sendFix(fix(50, lat: 14.7)); // older
      await sendFix(fix(140)); // stationary, within heartbeat
      expect(store.writes, hasLength(1));
    });

    test('poor-accuracy fixes are not written', () async {
      await emit([order('o1', 'in_transit')]);
      await sendFix(fix(0, acc: 500));
      expect(store.writes, isEmpty);
    });
  });
}
