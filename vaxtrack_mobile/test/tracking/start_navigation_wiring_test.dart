import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// HomeScreen and RouteMonitoringScreen read FirebaseAuth.instance, so they
/// cannot be pumped without Firebase. Their behaviour is proven through the
/// widget they now delegate to (tracking_session_scope_test.dart) and the
/// controller (rider_tracking_controller_test.dart); these pin the wiring.
String read(String path) => File(path).readAsStringSync().replaceAll('\r\n', '\n');

void main() {
  test('HomeScreen attaches through TrackingSessionScope with Firebase Auth\'s current user — no raw attach/shutdown of its own', () {
    final home = read('lib/screens/home_screen.dart');
    expect(home, contains('return TrackingSessionScope('));
    expect(home, contains('controller: riderTracking,'));
    expect(home, contains('riderUid: FirebaseAuth.instance.currentUser?.uid,'));
    expect(home, contains('ordersFor: trackedOrdersFor,'));
    // The old code shut the app-wide controller down from dispose, which could
    // run AFTER a remounted shell's attach and leave the rider detached.
    expect(home.contains('riderTracking.shutdown('), isFalse);
    expect(home.contains('riderTracking.attach('), isFalse);
  });

  test('the scope releases only its own claim', () {
    final scope = read('lib/tracking/tracking_session_scope.dart');
    expect(scope, contains('_attachment = uid == null ? null : widget.controller.attach(uid, widget.ordersFor(uid));'));
    expect(scope, contains('widget.controller.detach(_attachment, reason: kEndReasonTrackingStopped);'));
    expect(scope.contains('.shutdown('), isFalse);
  });

  test('RouteMonitoringScreen reads the signed-in uid at the tap, never a value cached when it opened', () {
    final screen = read('lib/screens/route_monitoring_screen.dart');
    expect(screen.contains('late final String? _uid'), isFalse);
    expect(screen, contains('String? get _uid => FirebaseAuth.instance.currentUser?.uid;'));
    expect(screen, contains('await riderTracking.startNavigation(d.id, authUid: _uid);'));
  });

  test('the app-wide controller can re-attach the signed-in rider; sign-out still shuts it down first', () {
    final service = read('lib/services/rider_tracking_service.dart');
    expect(service, contains('ordersFor: trackedOrdersFor,'));
    final auth = read('lib/services/auth_service.dart');
    final signOut = auth.substring(auth.indexOf('Future<void> signOut() async {'));
    expect(signOut.indexOf('.shutdown(reason: kEndReasonSignedOut)') < signOut.indexOf('await _auth.signOut();'), isTrue);
  });
}
