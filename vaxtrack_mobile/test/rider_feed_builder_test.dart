import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/widgets/rider_feed_builder.dart';

/// RiderFeedBuilder at runtime, driven by controlled streams: one subscription
/// per Rider, no spinner after the first load, a safe error with a Retry that
/// really reconnects, and a clean switch to another Rider's feed.

/// A controllable feed per Rider. Each `open` creates a NEW single-subscription
/// controller (as Firestore does per listen), so re-opening is observable.
class _Feeds {
  final Map<String, List<StreamController<List<String>>>> opened = {};
  int listens = 0;

  Stream<List<String>> open(String riderId) {
    final c = StreamController<List<String>>(onListen: () => listens += 1);
    opened.putIfAbsent(riderId, () => []).add(c);
    return c.stream;
  }

  int opens(String riderId) => opened[riderId]?.length ?? 0;
  StreamController<List<String>> latest(String riderId) => opened[riderId]!.last;
}

/// A host that can rebuild (fresh `open` closure each time) or switch Rider.
class _Host extends StatefulWidget {
  const _Host({required this.feeds, required this.riderId});
  final _Feeds feeds;
  final String riderId;
  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  int rebuilds = 0;
  void rebuild() => setState(() => rebuilds += 1);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: Column(children: [
          Text('rebuild $rebuilds'),
          Expanded(
            child: RiderFeedBuilder<List<String>>(
              riderId: widget.riderId,
              // A NEW closure on every rebuild — must not reconnect by itself.
              open: (id) => widget.feeds.open(id),
              component: 'TestScreen',
              what: 'your deliveries',
              builder: (context, items) => items.isEmpty
                  ? const Text('Nothing assigned')
                  : Text('Items: ${items.join(', ')}'),
            ),
          ),
        ]),
      ),
    );
  }
}

Finder get spinner => find.byType(CircularProgressIndicator);

/// Stream events reach the StreamBuilder through microtasks; depending on what
/// else happened in the frame the rebuild lands one frame later, so two frames
/// are pumped after every event (a harness detail, not app behaviour).
Future<void> deliver(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

void main() {
  late _Feeds feeds;
  setUp(() => feeds = _Feeds());

  Future<_HostState> pumpHost(WidgetTester tester, String riderId) async {
    await tester.pumpWidget(_Host(feeds: feeds, riderId: riderId));
    return tester.state<_HostState>(find.byType(_Host));
  }

  testWidgets('ordinary rebuilds do not resubscribe', (tester) async {
    final host = await pumpHost(tester, 'riderA');
    feeds.latest('riderA').add(['VT-1']);
    await deliver(tester);
    for (var i = 0; i < 5; i++) {
      host.rebuild();
      await deliver(tester);
    }
    expect(find.text('rebuild 5'), findsOneWidget);
    expect(feeds.opens('riderA'), 1, reason: 'opened once, despite five rebuilds');
    expect(feeds.listens, 1, reason: 'listened once');
    expect(find.text('Items: VT-1'), findsOneWidget);
    expect(spinner, findsNothing);
  });

  testWidgets('loading first, then later emissions update in place — never the spinner again', (tester) async {
    final host = await pumpHost(tester, 'riderA');
    expect(spinner, findsOneWidget, reason: 'first load');

    final feed = feeds.latest('riderA');
    feed.add(['VT-1']);
    await deliver(tester);
    expect(find.text('Items: VT-1'), findsOneWidget);

    feed.add(['VT-1', 'VT-2']);
    host.rebuild(); // an update and a rebuild in the same frame
    await deliver(tester);
    expect(find.text('Items: VT-1, VT-2'), findsOneWidget);
    expect(spinner, findsNothing);

    feed.add([]);
    await deliver(tester);
    expect(find.text('Nothing assigned'), findsOneWidget, reason: 'empty is data, not error or loading');
    expect(spinner, findsNothing);
    expect(find.byKey(const ValueKey('feed-error-message')), findsNothing);
  });

  testWidgets("another Rider: that Rider's feed, the old one released, none of the old content shown", (tester) async {
    await pumpHost(tester, 'riderA');
    final a = feeds.latest('riderA');
    a.add(['A-ORDER']);
    await deliver(tester);
    expect(find.text('Items: A-ORDER'), findsOneWidget);

    await tester.pumpWidget(_Host(feeds: feeds, riderId: 'riderB'));
    expect(feeds.opens('riderB'), 1);
    expect(a.hasListener, isFalse, reason: "the previous Rider's subscription is cancelled");
    expect(find.textContaining('A-ORDER'), findsNothing, reason: "no previous Rider content while B loads");
    expect(spinner, findsOneWidget);

    feeds.latest('riderB').add(['B-ORDER']);
    await deliver(tester);
    expect(find.text('Items: B-ORDER'), findsOneWidget);
    expect(find.textContaining('A-ORDER'), findsNothing);
  });

  testWidgets('leaving the screen releases the subscription', (tester) async {
    await pumpHost(tester, 'riderA');
    final a = feeds.latest('riderA');
    expect(a.hasListener, isTrue);
    await tester.pumpWidget(const MaterialApp(home: Text('signed out')));
    expect(a.hasListener, isFalse);
  });

  group('errors', () {
    testWidgets('safe wording only — the raw Firebase message never reaches the screen', (tester) async {
      await pumpHost(tester, 'riderA');
      feeds.latest('riderA').addError(FirebaseException(
        plugin: 'cloud_firestore',
        code: 'permission-denied',
        message: 'SECRET projects/x/databases/(default)/documents/orders rule detail',
      ));
      await deliver(tester);
      expect(find.textContaining('SECRET'), findsNothing);
      expect(find.textContaining('permission-denied'), findsNothing);
      expect(find.text('Could not load your deliveries — your account was refused access. '
          'Sign out and sign in again, or contact your dispatcher.'), findsOneWidget);
      expect(spinner, findsNothing);
    });

    testWidgets('a connection failure says so', (tester) async {
      await pumpHost(tester, 'riderA');
      feeds.latest('riderA').addError(FirebaseException(plugin: 'cloud_firestore', code: 'unavailable', message: 'x'));
      await deliver(tester);
      expect(find.text('Could not load your deliveries — no connection. Check your signal, then tap Retry.'),
          findsOneWidget);
    });

    testWidgets('Retry opens a NEW subscription and shows its data', (tester) async {
      await pumpHost(tester, 'riderA');
      final first = feeds.latest('riderA');
      first.add(['OLD']);
      await deliver(tester);
      first.addError(FirebaseException(plugin: 'cloud_firestore', code: 'unavailable'));
      await deliver(tester);
      expect(find.byKey(const ValueKey('feed-retry')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('feed-retry')));
      await deliver(tester);
      expect(feeds.opens('riderA'), 2, reason: 'Retry reconnects');
      expect(first.hasListener, isFalse, reason: 'the failed subscription is released');
      expect(spinner, findsOneWidget, reason: 'a fresh connection loads');
      expect(find.textContaining('OLD'), findsNothing);

      feeds.latest('riderA').add(['NEW']);
      await deliver(tester);
      expect(find.text('Items: NEW'), findsOneWidget);
    });

    testWidgets('the log line names the screen and the error TYPE only', (tester) async {
      final lines = <String>[];
      final original = debugPrint;
      debugPrint = (String? m, {int? wrapWidth}) => lines.add(m ?? '');
      try {
        await pumpHost(tester, 'riderA');
        feeds.latest('riderA').addError(
            FirebaseException(plugin: 'cloud_firestore', code: 'permission-denied', message: 'SECRET detail'));
        await deliver(tester);
        tester.state<_HostState>(find.byType(_Host)).rebuild(); // rebuilding does not log again
        await deliver(tester);
      } finally {
        debugPrint = original;
      }

      expect(lines.first, 'TestScreen: live feed failed (FirebaseException)');
      // The full error is a DEBUG-BUILD-ONLY line (safe_log.dart); release
      // builds print only the line above.
      expect(lines.where((l) => !l.contains('[debug-only detail]')).where((l) => l.contains('SECRET')), isEmpty);
      expect(lines.where((l) => l.startsWith('TestScreen: live feed failed')).length, 1);
      expect(kDebugMode, isTrue, reason: 'tests run in debug mode');
    });
  });
}
