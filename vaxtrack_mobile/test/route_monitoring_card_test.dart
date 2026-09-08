import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/widgets/route_monitoring_card.dart';

/// The rider's route-monitoring note must never claim a state it cannot observe.
///
/// This card previously rendered a green check with "Within Geofence" and "No
/// deviations detected" — every string `const`, with no argument, stream or
/// location behind it. A negative control confirmed it: the widget asserted
/// compliance while provably holding no state. These are the permanent
/// assertions that replaced it.
///
/// The constructor still takes NOTHING, which is exactly why none of these
/// success words may appear: there is no input from which any of them could be
/// true. If a future change wires real monitoring in, these tests should be
/// rewritten around that input rather than deleted.
Future<void> _pump(WidgetTester tester) {
  return tester.pumpWidget(
    const MaterialApp(
      home: Scaffold(body: RouteMonitoringCard()),
    ),
  );
}

/// Every phrasing that would tell the rider they are compliant, safe, tracked
/// or deviation-free. Substring matching, so a reworded variant is caught too.
const _forbiddenClaims = <String>[
  'Within Geofence',
  'No deviations detected',
  'monitored by the dispatch system',
  'Your current route compliance',
  'Geofence & Deviation Status',
  'Monitoring active',
  'On route',
  'Compliant',
  'No deviations',
];

void main() {
  testWidgets('renders the neutral information, and only that', (tester) async {
    await _pump(tester);

    expect(find.text('Route monitoring'), findsOneWidget);
    expect(
      find.text('Monitoring is available during an active delivery.'),
      findsOneWidget,
    );
  });

  testWidgets('makes no success or compliance claim', (tester) async {
    await _pump(tester);

    for (final claim in _forbiddenClaims) {
      expect(
        find.textContaining(claim),
        findsNothing,
        reason: 'the card has no state, so it must not claim "$claim"',
      );
    }
  });

  testWidgets('is not dressed as a success state', (tester) async {
    // The colour carries as much of the claim as the words: a green tick reads
    // as "you are compliant" regardless of the text beside it.
    await _pump(tester);

    final icon = tester.widget<Icon>(find.byType(Icon));
    expect(icon.icon, isNot(Icons.check_circle));
    expect(icon.icon, Icons.info_outline);
    expect(
      find.byIcon(Icons.check_circle),
      findsNothing,
      reason: 'no success tick without a state to succeed at',
    );
  });

  testWidgets('never claims monitoring is currently running', (tester) async {
    await _pump(tester);

    // "available during" is a statement about the feature. "is being" / "is
    // active" would be a statement about right now, which nothing here knows.
    expect(find.textContaining('is being monitored'), findsNothing);
    expect(find.textContaining('Monitoring is active'), findsNothing);
    expect(find.textContaining('currently'), findsNothing);
  });

  testWidgets('carries accessible semantics for the informational block', (tester) async {
    final handle = tester.ensureSemantics();
    await _pump(tester);

    // The heading is announced as a heading. The label is checked by
    // containment, not equality: Flutter merges adjacent text into one node, so
    // the footer sentence legitimately rides along with the title.
    final header = tester.getSemantics(find.text('Route monitoring'));
    expect(header.flagsCollection.isHeader, isTrue);
    expect(header.label, contains('Route monitoring'));

    // The status block is one labelled unit, and its label says the same
    // neutral thing the visible text does — a screen-reader user must not get
    // a different (or more confident) story than a sighted one.
    final blockLabel = tester
        .getSemantics(find.byType(RouteMonitoringCard))
        .toStringDeep();
    expect(blockLabel, contains('Monitoring is available during an active delivery.'));
    for (final claim in _forbiddenClaims) {
      expect(blockLabel, isNot(contains(claim)));
    }

    handle.dispose();
  });

  testWidgets('with NO authoritative state, renders the neutral state only', (tester) async {
    // Behavioural, not structural. The card is built the way the app builds it
    // — supplying no monitoring state — and the assertion is about what that
    // DEFAULT renders, not about the constructor's shape.
    //
    // This deliberately does not care whether the widget later accepts a real
    // state source. When customer geofencing lands, an authoritative value may
    // be passed and a live status may render from it; what must never change is
    // that the absent-state default stays neutral. Absence of contrary evidence
    // is not evidence of compliance.
    await _pump(tester);

    // Exactly the neutral pair, and nothing that reads as a status readout.
    expect(find.text('Route monitoring'), findsOneWidget);
    expect(
      find.text('Monitoring is available during an active delivery.'),
      findsOneWidget,
    );

    // The default must not assert any position, safety or history.
    for (final claim in _forbiddenClaims) {
      expect(
        find.textContaining(claim),
        findsNothing,
        reason: 'no monitoring state was supplied, so "$claim" cannot be known',
      );
    }
    expect(find.byIcon(Icons.check_circle), findsNothing);
  });

  testWidgets('the manual Start action is preserved in the wording', (tester) async {
    // Opening a delivery does not begin monitoring — the rider taps Start. The
    // sentence has to keep that, or it becomes a quieter version of the same
    // false claim.
    await _pump(tester);

    expect(
      find.text('Open an active delivery and start route monitoring for that trip.'),
      findsOneWidget,
    );
    // Phrasings that would imply merely opening the screen activates it.
    for (final implied in [
      'monitoring starts automatically',
      'will be monitored',
      'is monitored',
      'to start route monitoring',
    ]) {
      expect(
        find.textContaining(implied),
        findsNothing,
        reason: 'must not imply monitoring begins without the rider starting it',
      );
    }
  });
}
