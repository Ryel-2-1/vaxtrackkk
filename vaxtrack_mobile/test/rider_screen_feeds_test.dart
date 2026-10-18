import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/app_user.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/screens/dashboard_screen.dart';
import 'package:vaxtrack_mobile/screens/deliveries_screen.dart';
import 'package:vaxtrack_mobile/screens/profile_screen.dart';
import 'package:vaxtrack_mobile/services/delivery_service.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';

/// The real Dashboard, Deliveries and Profile screens at runtime, with their
/// Firestore feeds replaced by controlled streams through the screens' test
/// seams (riderId + feed). The Proof screen builds its Firebase services
/// itself, so it is covered by the shared RiderFeedBuilder tests and a source
/// guard instead.

const raw = 'SECRET projects/vaxtrack/databases/(default)/documents/orders';
FirebaseException denied() => FirebaseException(plugin: 'cloud_firestore', code: 'permission-denied', message: raw);

Delivery order(String id, String clinic) => Delivery.fromFirestore(id, {
      'orderNumber': 'VT-$id',
      'clinicName': clinic,
      'clinicAddress': 'Address',
      'status': 'in_transit',
      'assignedRiderId': 'riderA',
      'vaccineName': 'Vaccine',
      'quantity': 5,
      'unit': 'vials',
      'priority': 'Standard',
    });

RiderDeliveriesSnapshot snap(List<Delivery> d) =>
    RiderDeliveriesSnapshot(deliveries: d, isFromCache: false, hasPendingWrites: false);

/// One controllable feed per open() call, per Rider.
class _Feed<T> {
  final Map<String, List<StreamController<T>>> opened = {};
  Stream<T> open(String riderId) {
    final c = StreamController<T>();
    opened.putIfAbsent(riderId, () => []).add(c);
    return c.stream;
  }

  int opens(String id) => opened[id]?.length ?? 0;
  StreamController<T> last(String id) => opened[id]!.last;
}

/// Rebuilds its child on demand, handing the screen a NEW feed closure each
/// time (as a parent rebuild would).
class _Rebuilder extends StatefulWidget {
  const _Rebuilder(this.build);
  final Widget Function() build;
  @override
  State<_Rebuilder> createState() => _RebuilderState();
}

class _RebuilderState extends State<_Rebuilder> {
  void rebuild() => setState(() {});
  @override
  Widget build(BuildContext context) => widget.build();
}

Future<void> deliver(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

Widget app(Widget home) => MaterialApp(theme: AppTheme.theme, home: home);
Finder get spinner => find.byType(CircularProgressIndicator);

void main() {
  group('Dashboard', () {
    late _Feed<RiderDeliveriesSnapshot> feed;
    setUp(() => feed = _Feed());

    Widget dashboard(String riderId) =>
        app(_Rebuilder(() => DashboardScreen(riderId: riderId, deliveriesFeed: (id) => feed.open(id))));

    testWidgets('loading → data; rebuilds do not resubscribe; updates arrive in place', (tester) async {
      await tester.pumpWidget(dashboard('riderA'));
      expect(spinner, findsOneWidget);

      feed.last('riderA').add(snap([order('1', 'Alpha Clinic')]));
      await deliver(tester);
      expect(spinner, findsNothing);
      expect(find.textContaining('Alpha Clinic'), findsWidgets);

      for (var i = 0; i < 3; i++) {
        tester.state<_RebuilderState>(find.byType(_Rebuilder)).rebuild();
        await deliver(tester);
      }
      expect(feed.opens('riderA'), 1);

      feed.last('riderA').add(snap([order('1', 'Alpha Clinic'), order('2', 'Beta Clinic')]));
      await deliver(tester);
      expect(find.textContaining('Beta Clinic'), findsWidgets);
      expect(spinner, findsNothing);

      feed.last('riderA').add(snap([]));
      await deliver(tester);
      expect(find.text('No assigned deliveries yet.'), findsOneWidget, reason: 'empty is not an error');
    });

    testWidgets('a feed error shows safe wording, never the raw error; Retry reconnects', (tester) async {
      await tester.pumpWidget(dashboard('riderA'));
      feed.last('riderA').addError(denied());
      await deliver(tester);
      expect(find.textContaining('SECRET'), findsNothing);
      expect(find.textContaining('Error:'), findsNothing);
      expect(find.textContaining('Could not load your deliveries'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('feed-retry')));
      await deliver(tester);
      expect(feed.opens('riderA'), 2, reason: 'Retry opened a new subscription');
      feed.last('riderA').add(snap([order('3', 'Gamma Clinic')]));
      await deliver(tester);
      expect(find.textContaining('Gamma Clinic'), findsWidgets);
    });
  });

  group('Deliveries', () {
    testWidgets("an account change opens the new Rider's feed and shows none of the old content", (tester) async {
      final feed = _Feed<List<Delivery>>();
      await tester.pumpWidget(app(DeliveriesScreen(riderId: 'riderA', deliveriesFeed: feed.open)));
      feed.last('riderA').add([order('1', 'Rider A Clinic')]);
      await deliver(tester);
      expect(find.textContaining('Rider A Clinic'), findsWidgets);

      // Same screen State, different Rider.
      await tester.pumpWidget(app(DeliveriesScreen(riderId: 'riderB', deliveriesFeed: feed.open)));
      await deliver(tester);
      expect(feed.opens('riderB'), 1);
      expect(feed.last('riderA').hasListener, isFalse, reason: "Rider A's subscription released");
      expect(find.textContaining('Rider A Clinic'), findsNothing);

      feed.last('riderB').add([order('2', 'Rider B Clinic')]);
      await deliver(tester);
      expect(find.textContaining('Rider B Clinic'), findsWidgets);
      expect(find.textContaining('Rider A Clinic'), findsNothing);
    });

    testWidgets('a feed error is safe wording, distinct from the empty state', (tester) async {
      final feed = _Feed<List<Delivery>>();
      await tester.pumpWidget(app(DeliveriesScreen(riderId: 'riderA', deliveriesFeed: feed.open)));
      feed.last('riderA').addError(denied());
      await deliver(tester);
      expect(find.textContaining('SECRET'), findsNothing);
      expect(find.textContaining('Could not load your deliveries'), findsOneWidget);
      expect(find.text('No assigned deliveries yet.'), findsNothing);
    });
  });

  group('Profile', () {
    final user = AppUser(uid: 'riderA', email: 'a@x.test', name: 'Rider A', role: 'rider', status: 'approved');

    testWidgets('a failed delivery-count feed keeps the profile and Sign Out on screen', (tester) async {
      // Tall enough that the whole (lazily built) profile list is laid out.
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final profiles = _Feed<AppUser?>();
      final deliveries = _Feed<List<Delivery>>();
      await tester.pumpWidget(app(ProfileScreen(
          riderId: 'riderA', profileFeed: profiles.open, deliveriesFeed: deliveries.open)));
      profiles.last('riderA').add(user);
      await deliver(tester);
      expect(find.text('Rider A'), findsOneWidget);

      deliveries.last('riderA').addError(denied());
      await deliver(tester);
      expect(find.textContaining('SECRET'), findsNothing);
      expect(find.textContaining('Could not load your delivery counts'), findsOneWidget);
      expect(find.text('Rider A'), findsOneWidget, reason: 'profile still shown');
      expect(find.text('Sign Out'), findsOneWidget, reason: 'Sign Out still reachable');

      await tester.tap(find.byKey(const ValueKey('feed-retry')));
      await deliver(tester);
      expect(deliveries.opens('riderA'), 2);
      deliveries.last('riderA').add([order('1', 'C')]);
      await deliver(tester);
      expect(find.text('Total'), findsOneWidget);

      // A profile update does not resubscribe the delivery counts.
      profiles.last('riderA').add(user);
      await deliver(tester);
      expect(deliveries.opens('riderA'), 2);
      expect(profiles.opens('riderA'), 1);
    });

    testWidgets('a failed profile feed: safe wording, Retry, and Sign Out still reachable', (tester) async {
      final profiles = _Feed<AppUser?>();
      final deliveries = _Feed<List<Delivery>>();
      await tester.pumpWidget(app(ProfileScreen(
          riderId: 'riderA', profileFeed: profiles.open, deliveriesFeed: deliveries.open)));
      profiles.last('riderA').addError(denied());
      await deliver(tester);
      expect(find.textContaining('SECRET'), findsNothing);
      expect(find.textContaining('Could not load your profile'), findsOneWidget);
      expect(find.text('Sign Out'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('feed-retry')));
      await deliver(tester);
      expect(profiles.opens('riderA'), 2);
    });
  });
}
