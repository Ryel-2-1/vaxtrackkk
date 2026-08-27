import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/sync_status.dart';
import 'package:vaxtrack_mobile/widgets/sync_indicator.dart';

Future<void> _pump(WidgetTester tester, SyncStatus status) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(child: SyncIndicator(status: status)),
      ),
    ),
  );
}

void main() {
  testWidgets('shows "Synced" for a server-confirmed snapshot', (tester) async {
    await _pump(tester, SyncStatus.synced);
    expect(find.text('Synced'), findsOneWidget);
  });

  testWidgets('shows "Cached data" for a cache-only snapshot', (tester) async {
    await _pump(tester, SyncStatus.cached);
    expect(find.text('Cached data'), findsOneWidget);
    // Must never mislabel cached data as "Offline".
    expect(find.text('Offline'), findsNothing);
  });

  testWidgets('shows "Pending sync" when a write has not synced', (tester) async {
    await _pump(tester, SyncStatus.pending);
    expect(find.text('Pending sync'), findsOneWidget);
  });
}
