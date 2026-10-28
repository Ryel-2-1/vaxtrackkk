import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/tracking/location_write_policy.dart';
import 'package:vaxtrack_mobile/tracking/rider_tracking_controller.dart';
import 'package:vaxtrack_mobile/tracking/tracking_contract.dart';
import 'package:vaxtrack_mobile/tracking/tracking_lifecycle.dart';
import 'package:vaxtrack_mobile/tracking/tracking_session_scope.dart';

/// The field bug: an authenticated Rider with an In Transit order tapped Start
/// Navigation and was told "Sign in to start navigation." These tests drive the
/// REAL widget HomeScreen uses (TrackingSessionScope) through Flutter's own
/// mount/unmount order, with the real controller over fakes.

const rider = 'riderA';

class _Source implements TrackingLocationSource {
  final List<StreamController<LocationFix>> opened = [];
  @override
  Future<LocationAccess> checkAccess() async => LocationAccess.granted;
  @override
  Future<LocationAccess> requestAccess() async => LocationAccess.granted;
  // onCancel returns a future of THIS (fake-async) zone. Without it, cancel()
  // returns Dart's shared pre-completed future from the root zone, which a
  // widget test's fake clock never resumes — a harness artifact, not app
  // behaviour (the real Geolocator stream is unaffected).
  @override
  Stream<LocationFix> fixes(TrackingMode mode) {
    final c = StreamController<LocationFix>(onCancel: () async {});
    opened.add(c);
    return c.stream;
  }

  @override
  Future<bool> notificationsAllowed() async => true;
  @override
  Future<void> openAppSettings() async {}
  @override
  Future<void> openLocationSettings() async {}
  int get activeStreams => opened.where((c) => c.hasListener).length;
}

class _Store implements TrackingStore {
  final List<(String, String)> started = [];
  final List<(String, String)> endedSessions = [];
  int endedWrites = 0;
  @override
  Future<String?> navigatingSessionId(String riderUid) async => null;
  @override
  Future<void> writeLocation({required String riderUid, required LocationFix fix, String? activeOrderId, String? navigationSessionId}) async {}
  @override
  Future<void> writeEnded({required String riderUid, required DateTime at}) async => endedWrites++;
  @override
  Future<void> startSession({required String riderUid, required String orderId, required String sessionId}) async =>
      started.add((orderId, sessionId));
  @override
  Future<void> endSession({required String riderUid, required String sessionId, required String reason}) async =>
      endedSessions.add((sessionId, reason));
}

class _NoTimer implements Timer {
  @override
  bool get isActive => false;
  @override
  int get tick => 0;
  @override
  void cancel() {}
}

TrackedOrder inTransit(String id, {String to = rider}) => TrackedOrder(id: id, status: 'in_transit', assignedRiderId: to);

void main() {
  // Built INSIDE each testWidgets body (its fake-async zone), as
  // tracking_status_banner_test.dart does: the fakes resolve through
  // microtasks, so pumping frames settles the controller — nothing awaits
  // real time.
  late _Source source;
  late _Store store;
  late RiderTrackingController c;
  late List<StreamController<List<TrackedOrder>>> feeds;
  late List<TrackedOrder> current;

  Stream<List<TrackedOrder>> ordersFor(String uid) {
    final f = StreamController<List<TrackedOrder>>(onCancel: () async {});
    feeds.add(f);
    return f.stream;
  }

  void build() {
    source = _Source();
    store = _Store();
    feeds = [];
    current = [inTransit('o1')];
    c = RiderTrackingController(
      source: source,
      store: store,
      startTimer: (_, _) => _NoTimer(),
      ordersFor: ordersFor,
      ordersLoadTimeout: const Duration(milliseconds: 200),
    );
    addTearDown(c.dispose);
  }

  Widget shell(String? uid, {Key? key}) => MaterialApp(
        home: TrackingSessionScope(
          key: key,
          controller: c,
          riderUid: uid,
          ordersFor: ordersFor,
          child: const Text('home'),
        ),
      );

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.pump();
    }
  }

  /// Every live deliveries feed delivers the rider's current orders.
  Future<void> deliver(WidgetTester tester) async {
    for (final f in feeds) {
      if (f.hasListener) f.add(current);
    }
    await settle(tester);
  }

  Future<String?> tapStart(WidgetTester tester, String? authUid, [String orderId = 'o1']) async {
    String? result = 'pending';
    unawaited(c.startNavigation(orderId, authUid: authUid).then((r) => result = r));
    for (var i = 0; i < 10 && result == 'pending'; i++) {
      await tester.pump();
    }
    return result;
  }

  testWidgets('first launch: signed in with an in-transit order — Start Navigation works', (tester) async {
    build();
    await tester.pumpWidget(shell(rider));
    await deliver(tester);
    expect(c.readinessFor(rider), NavigationReadiness.ready);
    expect(await tapStart(tester, rider), isNull);
    expect(store.started.single.$1, 'o1');
  });

  testWidgets('first launch: a tap before the deliveries arrive waits for them — never "sign in"', (tester) async {
    build();
    await tester.pumpWidget(shell(rider));
    expect(c.readinessFor(rider), NavigationReadiness.loading);
    String? result = 'pending';
    unawaited(c.startNavigation('o1', authUid: rider).then((r) => result = r));
    await settle(tester);
    expect(result, 'pending', reason: 'waiting for the deliveries, not refusing');
    await deliver(tester);
    expect(result, isNull);
  });

  testWidgets('returning from Google Maps (paused → resumed): still attached, the same navigation session continues', (tester) async {
    build();
    await tester.pumpWidget(shell(rider));
    await deliver(tester);
    expect(await tapStart(tester, rider), isNull);
    final session = c.navigation!.sessionId;
    for (final state in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
      tester.binding.handleAppLifecycleStateChanged(state);
      await tester.pump();
    }
    expect(source.activeStreams, 1, reason: 'switching apps never stops a running stream');
    for (final state in [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
      tester.binding.handleAppLifecycleStateChanged(state);
      await tester.pump();
    }
    await settle(tester);
    expect(c.navigation?.sessionId, session);
    expect(store.endedSessions, isEmpty);
    expect(await tapStart(tester, rider), isNull, reason: 'tapping again on return is still fine');
    expect(store.started, hasLength(1), reason: 'already navigating it: no second session');
  });

  testWidgets('screen remount (new shell replaces the old in one frame): attachment and navigation survive', (tester) async {
    build();
    await tester.pumpWidget(shell(rider, key: const ValueKey('a')));
    await deliver(tester);
    expect(await tapStart(tester, rider), isNull);
    final session = c.navigation!.sessionId;
    // A different key: Flutter mounts the new scope and disposes the old one
    // in the same frame — the order the old code mishandled.
    await tester.pumpWidget(shell(rider, key: const ValueKey('b')));
    await settle(tester);
    expect(c.readinessFor(rider), NavigationReadiness.ready);
    expect(c.navigation?.sessionId, session);
    expect(store.endedSessions, isEmpty);
    expect(await tapStart(tester, rider), isNull);
  });

  testWidgets('rapid auth and lifecycle changes end attached and able to navigate', (tester) async {
    build();
    await tester.pumpWidget(shell(rider, key: const ValueKey(1)));
    await tester.pumpWidget(shell(rider, key: const ValueKey(2)));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pumpWidget(shell(null, key: const ValueKey(2))); // auth briefly null
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpWidget(shell(rider, key: const ValueKey(3)));
    await tester.pumpWidget(shell(rider, key: const ValueKey(4)));
    await settle(tester);
    await deliver(tester);
    expect(c.readinessFor(rider), NavigationReadiness.ready);
    expect(await tapStart(tester, rider), isNull);
    expect(source.activeStreams, 1, reason: 'one stream, never two');
  });

  testWidgets('genuine sign-out: tracking and navigation end, and a signed-out rider can never start', (tester) async {
    build();
    await tester.pumpWidget(shell(rider));
    await deliver(tester);
    expect(await tapStart(tester, rider), isNull);
    // AuthService.signOut: shut down first, then Firebase signs out and the shell goes.
    unawaited(c.shutdown(reason: kEndReasonSignedOut));
    await settle(tester);
    await tester.pumpWidget(const MaterialApp(home: Text('login')));
    await settle(tester);
    expect(store.endedSessions.single.$2, kEndReasonSignedOut);
    expect(source.activeStreams, 0);
    expect(store.endedWrites, greaterThan(0), reason: 'coordinates cleared');
    expect(await tapStart(tester, null), kSignInToNavigateMessage);
    expect(await tapStart(tester, ''), kSignInToNavigateMessage);
    expect(store.started, hasLength(1), reason: 'no session after sign-out');
  });

  testWidgets('a lost attachment re-attaches the SIGNED-IN rider and still checks assignment on the server feed', (tester) async {
    build();
    await tester.pumpWidget(shell(rider));
    await deliver(tester);
    // Any future lifecycle path that leaves the controller detached while
    // Firebase Auth still has the rider signed in.
    unawaited(c.shutdown(reason: kEndReasonTrackingStopped));
    await settle(tester);
    expect(c.readinessFor(rider), NavigationReadiness.loading);
    String? result = 'pending';
    unawaited(c.startNavigation('o1', authUid: rider).then((r) => result = r));
    await settle(tester);
    await deliver(tester); // the re-attached feed
    expect(result, isNull);

    // Assignment stays authoritative: an order assigned to someone else never starts.
    current = [inTransit('o2', to: 'riderB')];
    await deliver(tester);
    expect(await tapStart(tester, rider, 'o2'), 'This delivery is not assigned to you.');
  });

  test('deliveries that never load: a "still loading" message after the bound — not "sign in"', () async {
    final slow = RiderTrackingController(
      source: _Source(),
      store: _Store(),
      startTimer: (_, _) => _NoTimer(),
      ordersLoadTimeout: const Duration(milliseconds: 30),
    );
    slow.attach(rider, StreamController<List<TrackedOrder>>().stream);
    expect(await slow.startNavigation('o1', authUid: rider), kDeliveriesLoadingMessage);
    final broken = RiderTrackingController(source: _Source(), store: _Store(), startTimer: (_, _) => _NoTimer());
    broken.attach(rider, Stream<List<TrackedOrder>>.error(StateError('offline')));
    await pumpEventQueue();
    expect(await broken.startNavigation('o1', authUid: rider), kDeliveriesUnreadableMessage);
    slow.dispose();
    broken.dispose();
  });
}
