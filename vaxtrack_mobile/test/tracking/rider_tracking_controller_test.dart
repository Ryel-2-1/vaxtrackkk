import 'dart:async';

import 'dart:ui' show AppLifecycleState;

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
  final List<StreamController<LocationFix>> opened = [];

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
    opened.add(current!);
    return current!.stream;
  }

  bool get streaming => current != null && current!.hasListener;

  /// Streams with a listener right now — there must never be more than one.
  int get activeStreams => opened.where((c) => c.hasListener).length;

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
  Completer<void>? holdEnded; // when set, writeEnded / endSession wait (offline sign-out)
  bool failStart = false;
  String? serverSession; // a session the SERVER still holds as navigating

  @override
  Future<String?> navigatingSessionId(String riderUid) async => serverSession;

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
  Future<void> writeEnded({required String riderUid, required DateTime at}) async {
    if (holdEnded != null) await holdEnded!.future;
    ended.add(at);
  }

  @override
  Future<void> startSession({required String riderUid, required String orderId, required String sessionId}) async {
    if (failStart) throw StateError('offline');
    started.add((orderId, sessionId));
  }

  @override
  Future<void> endSession({required String riderUid, required String sessionId, required String reason}) async {
    if (holdEnded != null) await holdEnded!.future;
    endedSessions.add((sessionId, reason));
  }
}

/// Manual timers: the first-fix watchdog fires only when a test says so.
class FakeTimer implements Timer {
  FakeTimer(this.duration, this._callback);
  final Duration duration;
  final void Function() _callback;
  bool _active = true;
  @override
  bool get isActive => _active;
  @override
  int get tick => 0;
  @override
  void cancel() => _active = false;
  void fire() {
    if (!_active) return;
    _active = false;
    _callback();
  }
}

class FakeTimers {
  final List<FakeTimer> all = [];
  Timer start(Duration d, void Function() cb) {
    final t = FakeTimer(d, cb);
    all.add(t);
    return t;
  }

  List<FakeTimer> get active => all.where((t) => t.isActive).toList();
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
  late FakeTimers timers;

  setUp(() {
    source = FakeSource();
    store = FakeStore();
    timers = FakeTimers();
    c = RiderTrackingController(
      source: source,
      store: store,
      clock: () => t0.add(const Duration(hours: 1)),
      startTimer: timers.start,
    );
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
      final error = await c.startNavigation('o1', authUid: rider);
      expect(error, 'Navigation starts once the delivery is in transit.');
      expect(store.started, isEmpty);
    });

    test('start opens a session and switches to navigating; writes carry the session', () async {
      await emit([order('o1', 'in_transit')]);
      expect(await c.startNavigation('o1', authUid: rider), isNull);
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
      expect(await c.startNavigation('o1', authUid: rider), isNotNull);
      expect(c.navigation, isNull);
      expect(c.status, TrackingStatus.tracking);
    });

    test('starting another order replaces the route (one session per rider)', () async {
      await emit([order('o1', 'in_transit'), order('o2', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      final first = c.navigation!.sessionId;
      await c.startNavigation('o2', authUid: rider);
      expect(c.navigation!.orderId, 'o2');
      expect(c.navigation!.sessionId, isNot(first));
      expect(store.started.map((s) => s.$1), ['o1', 'o2']);
    });

    test('starting the same order twice is a no-op', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      await c.startNavigation('o1', authUid: rider);
      expect(store.started, hasLength(1));
    });

    test('Stop ends the session as rider_stopped and keeps tracking', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      final sid = c.navigation!.sessionId;
      await c.stopNavigation();
      expect(store.endedSessions.single, (sid, kEndReasonRiderStopped));
      expect(c.status, TrackingStatus.tracking);
    });

    test('the navigated order completing ends the session', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      await emit([order('o1', 'delivered')]);
      expect(store.endedSessions.single.$2, kEndReasonTrackingStopped);
      expect(c.navigation, isNull);
      expect(c.status, TrackingStatus.idle);
    });
  });

  test('sign-out ends navigation and tracking and clears coordinates', () async {
    await emit([order('o1', 'in_transit')]);
    await c.startNavigation('o1', authUid: rider);
    await sendFix(fix(0));
    await c.shutdown(reason: kEndReasonSignedOut);
    expect(store.endedSessions.single.$2, kEndReasonSignedOut);
    expect(store.ended, hasLength(1));
    expect(source.streaming, isFalse);
    expect(c.status, TrackingStatus.idle);
    // Later order snapshots are no longer followed.
    expect(orders.hasListener, isFalse);
  });

  group('locked screen / app lifecycle', () {
    // HomeScreen maps every lifecycle state through foregroundForLifecycle.
    Future<void> lifecycle(AppLifecycleState state) async {
      final foreground = foregroundForLifecycle(state);
      if (foreground != null) await c.setForeground(foreground);
    }

    test('locking the phone keeps a running session: no cancel, fixes still written', () async {
      await emit([order('o1', 'assigned')]);
      expect(source.activeStreams, 1);
      for (final state in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
        await lifecycle(state);
        expect(source.streaming, isTrue, reason: '$state must not cancel the stream');
      }
      expect(c.status, TrackingStatus.tracking);
      await sendFix(fix(0));
      await sendFix(fix(130, lat: 14.6)); // stationary heartbeat while locked
      expect(store.writes, hasLength(2), reason: 'the write policy keeps running while locked');
      expect(source.streamsOpened, [TrackingMode.tracking]);
    });

    test('resuming does not create a second stream', () async {
      await emit([order('o1', 'in_transit')]);
      await lifecycle(AppLifecycleState.paused);
      await lifecycle(AppLifecycleState.resumed);
      await lifecycle(AppLifecycleState.paused);
      await lifecycle(AppLifecycleState.resumed);
      expect(source.streamsOpened, [TrackingMode.tracking]);
      expect(source.activeStreams, 1);
    });

    test('a navigating session also survives locking', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      await lifecycle(AppLifecycleState.paused);
      expect(source.streaming, isTrue);
      expect(c.status, TrackingStatus.navigating);
      expect(source.activeStreams, 1);
    });

    test('switching tracking <-> navigation replaces the stream: never two at once', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      expect(source.activeStreams, 1);
      expect(source.opened.first.hasListener, isFalse, reason: 'the tracking stream was cancelled first');
      await c.stopNavigation();
      expect(source.activeStreams, 1);
      expect(source.streamsOpened, [TrackingMode.tracking, TrackingMode.navigating, TrackingMode.tracking]);
    });

    test('an active order starts tracking while the app is foregrounded', () async {
      await emit([order('o1', 'assigned')]);
      expect(source.streamsOpened, [TrackingMode.tracking]);
    });

    test('sign-out while locked still stops the stream (releasing its service)', () async {
      await emit([order('o1', 'in_transit')]);
      await lifecycle(AppLifecycleState.paused);
      await c.shutdown(reason: kEndReasonSignedOut);
      expect(source.activeStreams, 0);
    });

    test('no active delivery: nothing is listened to, so nothing holds a wake lock', () async {
      await emit([order('o1', 'in_transit')]);
      await emit([order('o1', 'delivered')]);
      expect(source.activeStreams, 0);
      await lifecycle(AppLifecycleState.resumed);
      expect(source.activeStreams, 0);
    });
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
      await c.startNavigation('o1', authUid: rider);
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

  group('notifications and the first position (staging QA A-1)', () {
    test('notifications off: never claimed as sharing before a position arrives', () async {
      source.notifications = false;
      await emit([order('o1', 'assigned')]);
      expect(c.status, TrackingStatus.tracking, reason: 'the plan: an active delivery');
      expect(c.notificationsAllowed, isFalse);
      expect(c.sharingConfirmed, isFalse, reason: 'no position yet — not "sharing"');
      await sendFix(fix(0));
      expect(c.sharingConfirmed, isTrue);
      expect(store.writes, hasLength(1));
    });

    test('granting notifications restarts the ONE stream at once — no ten-minute wait', () async {
      source.notifications = false;
      await emit([order('o1', 'assigned')]);
      await sendFix(fix(0));
      expect(source.streamsOpened, hasLength(1));
      source.notifications = true;
      await c.setForeground(true); // back from App settings
      expect(c.notificationsAllowed, isTrue);
      expect(source.streamsOpened, hasLength(2), reason: 'restarted immediately, not after a timeout');
      expect(source.activeStreams, 1, reason: 'never two streams');
      await c.setForeground(true);
      expect(source.streamsOpened, hasLength(2), reason: 'only on the change, not every resume');
    });

    test('a stream that stays silent is replaced after the timeout and the rider is told', () async {
      await emit([order('o1', 'assigned')]);
      expect(timers.active.single.duration, const Duration(seconds: 45));
      expect(c.sharingConfirmed, isFalse);
      timers.active.single.fire();
      await pumpEventQueue();
      await c.idle;
      expect(source.streamsOpened, hasLength(2));
      expect(source.activeStreams, 1, reason: 'the silent stream was cancelled first');
      expect(c.lastError, kNoFixYetMessage);
      expect(c.restartsWithoutFix, 1);
      await sendFix(fix(0));
      expect(c.sharingConfirmed, isTrue);
      expect(c.lastError, isNull);
      expect(timers.active, isEmpty, reason: 'the watchdog stops once a position arrives');
    });

    test('Retry replaces a silent stream; a working stream is never restarted by Retry', () async {
      await emit([order('o1', 'assigned')]);
      await c.retry();
      expect(source.streamsOpened, hasLength(2));
      expect(source.activeStreams, 1);
      await sendFix(fix(0));
      await c.retry();
      expect(source.streamsOpened, hasLength(2));
    });

    test('"sharing" only once a position is SAVED — not when a stream exists or a fix is received', () async {
      store.hold = Completer<void>();
      await emit([order('o1', 'assigned')]);
      expect(source.streaming, isTrue);
      expect(c.sharingConfirmed, isFalse, reason: 'a stream object alone is not sharing');
      await sendFix(fix(0));
      expect(store.writes, hasLength(1));
      expect(c.sharingConfirmed, isFalse, reason: 'received, write still in flight');
      store.hold!.complete();
      await pumpEventQueue();
      expect(c.sharingConfirmed, isTrue);
    });

    test('a received fix that is never saved (too inaccurate) keeps it "starting"', () async {
      await emit([order('o1', 'assigned')]);
      await sendFix(fix(0, acc: 500));
      expect(store.writes, isEmpty);
      expect(c.sharingConfirmed, isFalse);
    });

    test('switching to navigation needs a new saved position before it is "sharing" again', () async {
      await emit([order('o1', 'in_transit')]);
      await sendFix(fix(0));
      expect(c.sharingConfirmed, isTrue);
      await c.startNavigation('o1', authUid: rider);
      expect(c.sharingConfirmed, isFalse, reason: 'new stream, nothing saved on it yet');
      await sendFix(fix(15)); // past the navigation minimum write interval
      expect(c.sharingConfirmed, isTrue);
    });

    test('losing location permission cancels the watchdog and the stream', () async {
      await emit([order('o1', 'assigned')]);
      expect(timers.active, hasLength(1));
      source.access = LocationAccess.denied;
      await c.setForeground(true); // back from App settings: re-checked
      expect(timers.active, isEmpty);
      expect(source.activeStreams, 0);
      expect(c.status, TrackingStatus.needsPermission);
      source.access = LocationAccess.granted;
      await c.setForeground(true);
      expect(source.activeStreams, 1, reason: 'granted again: one stream');
    });

    test('sign-out cancels every timer and stream', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      await c.shutdown(reason: kEndReasonSignedOut);
      expect(timers.active, isEmpty);
      expect(source.activeStreams, 0);
      expect(orders.hasListener, isFalse);
    });

    test('dispose releases every timer and stream, and nothing restarts afterwards', () async {
      await emit([order('o1', 'assigned')]);
      expect([timers.active.length, source.activeStreams], [1, 1]);
      c.dispose();
      await pumpEventQueue();
      expect(timers.active, isEmpty);
      expect(source.activeStreams, 0);
      expect(orders.hasListener, isFalse);
      final opened = source.streamsOpened.length;
      c.attach('riderZ', Stream.value([order('o9', 'assigned', to: 'riderZ')]));
      await pumpEventQueue();
      expect(source.streamsOpened.length, opened);
    });

    test('stopping sharing cancels the watchdog', () async {
      await emit([order('o1', 'assigned')]);
      await emit([order('o1', 'delivered')]);
      expect(timers.active, isEmpty);
    });
  });

  group('navigation sessions left behind (staging QA A-F1)', () {
    test('a session the server still holds from a killed app is ended on sign-in', () async {
      final s2 = FakeStore()..serverSession = 'oldSession001';
      final c2 = RiderTrackingController(source: FakeSource(), store: s2, startTimer: FakeTimers().start);
      c2.attach(rider, const Stream<List<TrackedOrder>>.empty());
      await pumpEventQueue();
      await c2.idle;
      expect(s2.endedSessions, [('oldSession001', kEndReasonTrackingStopped)]);
      expect(c2.navigation, isNull);
    });

    test('no leftover session: nothing is ended', () async {
      await emit([order('o1', 'in_transit')]);
      expect(store.endedSessions, isEmpty);
    });

    test('a session this app starts after sign-in is never ended by the leftover check', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      expect(store.endedSessions, isEmpty);
      expect(c.navigation, isNotNull);
    });

    test('a DELAYED order keeps its running navigation, and Stop still ends it', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      final sid = c.navigation!.sessionId;
      await emit([order('o1', 'delayed')]);
      expect(c.navigation?.sessionId, sid, reason: 'delayed is still navigable');
      expect(c.status, TrackingStatus.navigating);
      await c.stopNavigation();
      expect(store.endedSessions.single, (sid, kEndReasonRiderStopped), reason: 'no status change needed to stop');
      expect(c.status, TrackingStatus.tracking);
    });

    test('ineligible transitions end navigation: unassigned, cancelled, failed, delivered', () async {
      for (final next in [
        [order('o1', 'in_transit', to: 'riderB')],
        [order('o1', 'cancelled')],
        [order('o1', 'delivery_failed')],
        [order('o1', 'delivered')],
        [order('o1', 'assigned')],
      ]) {
        store.endedSessions.clear();
        await emit([order('o1', 'in_transit')]);
        await c.startNavigation('o1', authUid: rider);
        final sid = c.navigation!.sessionId;
        await emit(next);
        expect(store.endedSessions, [(sid, kEndReasonTrackingStopped)], reason: '${next.first.status}/${next.first.assignedRiderId}');
        expect(c.navigation, isNull);
      }
    });
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

  // ------------------------------------------------------------------
  // "Sign in to start navigation" for a SIGNED-IN rider (the field bug).
  // HomeScreen attaches in initState and shuts tracking down in dispose; the
  // controller is app-wide. attach() runs at once, shutdown() is queued — so a
  // teardown requested BEFORE a newer attach could still run AFTER it and
  // clear the newer attachment.
  group('an old teardown never clears a newer attachment', () {
    test('screen remount: old dispose, then new initState (same frame)', () async {
      await emit([order('o1', 'in_transit')]);
      final orders2 = StreamController<List<TrackedOrder>>();
      unawaited(c.shutdown(reason: kEndReasonTrackingStopped)); // old HomeScreen.dispose
      c.attach(rider, orders2.stream); // new HomeScreen.initState
      orders2.add([order('o1', 'in_transit')]);
      await pumpEventQueue();
      await c.idle;
      expect(await c.startNavigation('o1', authUid: rider), isNull);
      expect(c.navigation?.orderId, 'o1');
    });

    test('screen remount: new initState runs before the old dispose', () async {
      final oldClaim = c.attach(rider, orders.stream); // the mounted HomeScreen's claim
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      final session = c.navigation!.sessionId;
      final orders2 = StreamController<List<TrackedOrder>>();
      c.attach(rider, orders2.stream); // new HomeScreen.initState
      unawaited(c.detach(oldClaim)); // old HomeScreen.dispose releases ONLY its own claim
      orders2.add([order('o1', 'in_transit')]);
      await pumpEventQueue();
      await c.idle;
      expect(c.navigation?.sessionId, session, reason: 'the navigation session survives the remount');
      expect(store.endedSessions, isEmpty);
      expect(await c.startNavigation('o1', authUid: rider), isNull);
    });

    test('a genuine sign-out requested AFTER an attach does tear it down', () async {
      await emit([order('o1', 'in_transit')]);
      final orders2 = StreamController<List<TrackedOrder>>();
      c.attach(rider, orders2.stream);
      unawaited(c.shutdown(reason: kEndReasonSignedOut)); // AuthService.signOut
      orders2.add([order('o1', 'in_transit')]);
      await pumpEventQueue();
      await c.idle;
      expect(c.readinessFor(rider), NavigationReadiness.loading, reason: 'detached by the sign-out');
      expect(await c.startNavigation('o1', authUid: null), kSignInToNavigateMessage);
      expect(store.started, isEmpty, reason: 'never starts for a signed-out rider');
    });

    test('offline sign-out still finishing when the rider signs straight back in', () async {
      await emit([order('o1', 'in_transit')]);
      await c.startNavigation('o1', authUid: rider);
      store.holdEnded = Completer<void>(); // ending the session cannot reach the server
      unawaited(c.shutdown(reason: kEndReasonSignedOut)); // AuthService.signOut (gives up after 5 s)
      await pumpEventQueue();
      final orders2 = StreamController<List<TrackedOrder>>();
      c.attach(rider, orders2.stream); // signed in again
      orders2.add([order('o1', 'in_transit')]);
      await pumpEventQueue();
      store.holdEnded!.complete(); // the old sign-out finally finishes
      store.holdEnded = null;
      await pumpEventQueue();
      await c.idle;
      expect(await c.startNavigation('o1', authUid: rider), isNull, reason: 'the new sign-in stays attached');
    });
  });
  // ------------------------------------------------------------------
  // Return to the hub: after the last delivery the server's trip state
  // (riderDispatchStates) keeps location sharing on — with no order and no
  // navigation — until the return is confirmed (available_at_hub) or the
  // rider signs out. Arrival is never inferred on the device.
  group('returning to the hub (server trip state)', () {
    late FakeSource hs;
    late FakeStore hstore;
    late RiderTrackingController h;
    late StreamController<List<TrackedOrder>> ho;
    late StreamController<String?> trip;

    setUp(() {
      hs = FakeSource();
      hstore = FakeStore();
      ho = StreamController<List<TrackedOrder>>();
      trip = StreamController<String?>();
      h = RiderTrackingController(
        source: hs,
        store: hstore,
        clock: () => t0.add(const Duration(hours: 1)),
        startTimer: FakeTimers().start,
        tripStateFor: (_) => trip.stream,
      );
      h.attach(rider, ho.stream);
    });

    Future<void> orders(List<TrackedOrder> list) async {
      ho.add(list);
      await pumpEventQueue();
      await h.idle;
    }

    Future<void> tripState(String? s) async {
      trip.add(s);
      await pumpEventQueue();
      await h.idle;
    }

    Future<void> fixAt(int s) async {
      hs.current!.add(fix(s));
      await pumpEventQueue();
    }

    test('last delivery done, trip returning: sharing continues with no order and no navigation', () async {
      await tripState('on_trip');
      await orders([order('o1', 'in_transit')]);
      await h.startNavigation('o1', authUid: rider);
      expect(h.status, TrackingStatus.navigating);
      await tripState('returning_to_hub');
      await orders([order('o1', 'delivered')]);
      expect(h.status, TrackingStatus.returningToHub);
      expect(h.mode, TrackingMode.returning);
      expect(h.returningToHub, isTrue);
      expect(h.activeOrderIds, isEmpty);
      expect(h.navigation, isNull, reason: 'order navigation and route monitoring end');
      expect(hstore.endedSessions.single.$2, kEndReasonTrackingStopped);
      expect(hstore.ended, isEmpty, reason: 'coordinates are NOT cleared while returning');
      expect(hs.activeStreams, 1, reason: 'one stream, still running');
      expect(hs.streamsOpened.last, TrackingMode.returning, reason: 'the notification says returning to the hub');
      await fixAt(3600);
      final w = hstore.writes.last;
      expect([w.orderId, w.sessionId], [null, null], reason: 'no active order id, no session');
    });

    test('race: the last order finishes BEFORE the trip state settles — sharing never stops in between', () async {
      await tripState('on_trip');
      await orders([order('o1', 'in_transit')]);
      await fixAt(0);
      final ended = hstore.ended.length;
      // The order write arrives first; the trip still says on_trip.
      await orders([order('o1', 'delivered')]);
      expect(h.status, TrackingStatus.returningToHub);
      expect(hs.activeStreams, 1);
      expect(hstore.ended.length, ended, reason: 'nothing cleared during the gap');
      // Then the trip settles.
      await tripState('returning_to_hub');
      expect(h.status, TrackingStatus.returningToHub);
      expect(hs.activeStreams, 1);
      expect(hstore.ended.length, ended);
    });

    test('race the other way: the trip state settles while the last order still looks active', () async {
      await tripState('on_trip');
      await orders([order('o1', 'in_transit')]);
      await tripState('returning_to_hub');
      expect(h.status, TrackingStatus.tracking, reason: 'the active order still decides');
      await orders([order('o1', 'delivered')]);
      expect(h.status, TrackingStatus.returningToHub);
    });

    test('an authorized return confirmation (available_at_hub) stops sharing and clears coordinates', () async {
      await tripState('returning_to_hub');
      await orders([order('o1', 'delivered')]);
      await fixAt(10);
      expect(hs.activeStreams, 1);
      await tripState('available_at_hub');
      expect(h.status, TrackingStatus.idle);
      expect(hs.activeStreams, 0);
      expect(hstore.ended, hasLength(1), reason: 'coordinates cleared');
    });

    test('sign-out while returning stops sharing and clears coordinates', () async {
      await tripState('returning_to_hub');
      await orders(const []);
      await fixAt(10);
      await h.shutdown(reason: kEndReasonSignedOut);
      expect(hs.activeStreams, 0);
      expect(hstore.ended, hasLength(1));
      trip.add('returning_to_hub'); // a late event after sign-out
      await pumpEventQueue();
      await h.idle;
      expect(hs.activeStreams, 0, reason: 'nothing restarts after sign-out');
    });

    test('no trip state, an unknown one, or an unreadable one with no active order: nothing is shared', () async {
      await orders(const []);
      expect(h.status, TrackingStatus.idle);
      for (final s in [null, 'available_at_hub', 'trip_forming', 'something_else']) {
        await tripState(s);
        expect(h.status, TrackingStatus.idle, reason: '$s');
        expect(hs.activeStreams, 0, reason: '$s');
      }
      await tripState('returning_to_hub');
      expect(hs.activeStreams, 1);
      trip.addError(StateError('permission-denied'));
      await pumpEventQueue();
      await h.idle;
      expect(h.status, TrackingStatus.idle, reason: 'never shares on a guess');
      expect(hs.activeStreams, 0);
    });

    test('a new delivery while returning switches back to delivery tracking', () async {
      await tripState('returning_to_hub');
      await orders(const []);
      expect(h.status, TrackingStatus.returningToHub);
      await orders([order('o2', 'assigned')]);
      expect(h.status, TrackingStatus.tracking);
      expect(h.activeOrderIds, ['o2']);
    });

    test('the switch to returning in the background keeps the running stream (Android cannot restart it there)', () async {
      await tripState('on_trip');
      await orders([order('o1', 'in_transit')]);
      await h.setForeground(false);
      await orders([order('o1', 'delivered')]);
      expect(hs.activeStreams, 1, reason: 'not stopped');
      expect(hs.streamsOpened, [TrackingMode.tracking], reason: 'no restart from the background');
      expect(h.status, TrackingStatus.returningToHub);
      await h.setForeground(true);
      expect(hs.streamsOpened.last, TrackingMode.returning, reason: 'its returning notification once in the foreground');
      expect(hs.activeStreams, 1);
    });

    test('startup: a trip state that arrives before the deliveries never starts "returning" on its own', () async {
      await tripState('on_trip');
      expect(h.status, isNot(TrackingStatus.returningToHub));
      expect(hs.streamsOpened, isEmpty, reason: 'deliveries not loaded: no active order is not yet known');
      await orders([order('o1', 'in_transit')]);
      expect(hs.streamsOpened, [TrackingMode.tracking], reason: 'no returning→tracking flicker');
    });

    test('deliveries unreadable: the trip state alone never shares', () async {
      final h2o = StreamController<List<TrackedOrder>>();
      final h2s = FakeSource();
      final h2 = RiderTrackingController(
        source: h2s,
        store: FakeStore(),
        clock: () => t0,
        startTimer: FakeTimers().start,
        tripStateFor: (_) => Stream.value('returning_to_hub'),
      );
      h2.attach(rider, h2o.stream);
      h2o.addError(StateError('permission-denied'));
      await pumpEventQueue();
      await h2.idle;
      expect(h2s.streamsOpened, isEmpty);
      h2.dispose();
    });

    test('returning writes use the ordinary tracking cadence, never the navigating one', () async {
      expect(kWriteCadence[TrackingMode.returning]!.minInterval, kWriteCadence[TrackingMode.tracking]!.minInterval);
      expect(kWriteCadence[TrackingMode.returning]!.heartbeat, kWriteCadence[TrackingMode.tracking]!.heartbeat);
    });
  });
}
