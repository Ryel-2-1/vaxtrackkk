import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/tracking/location_write_policy.dart';
import 'package:vaxtrack_mobile/tracking/rider_tracking_controller.dart';
import 'package:vaxtrack_mobile/tracking/tracking_lifecycle.dart';
import 'package:vaxtrack_mobile/widgets/tracking_status_banner.dart';

class _Source implements TrackingLocationSource {
  _Source(this.access, {this.notifications = true});
  LocationAccess access;
  bool notifications;
  @override
  Future<bool> notificationsAllowed() async => notifications;
  @override
  Future<LocationAccess> checkAccess() async => access;
  @override
  Future<LocationAccess> requestAccess() async => access;
  @override
  Stream<LocationFix> fixes(TrackingMode mode) => const Stream.empty();
  @override
  Future<void> openAppSettings() async {}
  @override
  Future<void> openLocationSettings() async {}
}

class _Store implements TrackingStore {
  @override
  Future<void> writeLocation({
    required String riderUid,
    required LocationFix fix,
    String? activeOrderId,
    String? navigationSessionId,
  }) async {}
  @override
  Future<void> writeEnded({required String riderUid, required DateTime at}) async {}
  @override
  Future<void> startSession({required String riderUid, required String orderId, required String sessionId}) async {}
  @override
  Future<void> endSession({required String riderUid, required String sessionId, required String reason}) async {}
}

void main() {
  Future<RiderTrackingController> controllerWith(WidgetTester tester, LocationAccess access,
      {List<TrackedOrder>? orders, bool notifications = true}) async {
    final c = RiderTrackingController(source: _Source(access, notifications: notifications), store: _Store());
    final stream = StreamController<List<TrackedOrder>>();
    c.attach('r1', stream.stream);
    stream.add(orders ?? const [TrackedOrder(id: 'o1', status: 'assigned', assignedRiderId: 'r1')]);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: TrackingStatusBanner(controller: c))));
    // The fakes resolve through microtasks only; a few frames settle the
    // controller's serialized reconcile and rebuild the banner.
    for (var i = 0; i < 5; i++) {
      await tester.pump();
    }
    return c;
  }

  testWidgets('hidden when there is no active delivery', (tester) async {
    await controllerWith(tester, LocationAccess.granted, orders: const []);
    expect(find.byType(Card), findsNothing);
    expect(find.byType(TextButton), findsNothing);
  });

  testWidgets('explains sharing BEFORE asking for permission', (tester) async {
    await controllerWith(tester, LocationAccess.denied);
    expect(find.text(TrackingStatusBanner.messages[TrackingStatus.needsPermission]!), findsOneWidget);
    expect(find.text('Allow location'), findsOneWidget);
  });

  testWidgets('blocked permission offers app settings and retry', (tester) async {
    await controllerWith(tester, LocationAccess.deniedForever);
    expect(find.text('Open app settings'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('location off offers location settings and retry', (tester) async {
    await controllerWith(tester, LocationAccess.serviceDisabled);
    expect(find.text('Location settings'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('tracking shows how many deliveries are shared', (tester) async {
    await controllerWith(tester, LocationAccess.granted);
    expect(find.text('Sharing your location for 1 active delivery.'), findsOneWidget);
  });

  testWidgets('notifications off: says the notification is hidden and offers settings', (tester) async {
    await controllerWith(tester, LocationAccess.granted, notifications: false);
    expect(find.textContaining(TrackingStatusBanner.notificationsHiddenMessage), findsOneWidget);
    expect(find.text('Notification settings'), findsOneWidget);
  });

  testWidgets('notifications on: no notification warning', (tester) async {
    await controllerWith(tester, LocationAccess.granted);
    expect(find.text('Notification settings'), findsNothing);
  });

  test('the explanation names who sees the location and when it stops', () {
    final text = TrackingStatusBanner.messages[TrackingStatus.needsPermission]!;
    expect(text, contains('dispatch'));
    expect(text, contains('Med Rep'));
    expect(text, contains('notification'));
    expect(text, contains('stops automatically'));
  });
}
