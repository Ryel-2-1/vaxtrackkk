import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/widgets/info_help.dart';

void main() {
  testWidgets('a phone user can tap an information icon to read its explanation', (tester) async {
    const message = 'Take the proof and invoice photos before completing the delivery.';
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: InfoHeading(title: 'Proof of delivery', message: message)),
    ));
    expect(find.text('Proof of delivery'), findsOneWidget);
    expect(find.text(message), findsNothing);
    await tester.tap(find.byIcon(Icons.info_outline));
    await tester.pumpAndSettle();
    expect(find.text(message), findsOneWidget);
    expect(tester.takeException(), isNull);
    Tooltip.dismissAllToolTips();
    await tester.pumpAndSettle();
    expect(find.text(message), findsNothing);
  });

  testWidgets('long explanations fit a narrow screen and large text', (tester) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
      home: MediaQuery(
        data: const MediaQueryData(size: Size(320, 700), textScaler: TextScaler.linear(2)),
        child: const Scaffold(body: InfoHeading(
          title: 'Route monitoring',
          message: 'Monitoring is available during an active delivery. Open an active delivery and start route monitoring for that trip.',
        )),
      ),
    ));
    await tester.tap(find.byIcon(Icons.info_outline));
    await tester.pumpAndSettle();
    expect(find.textContaining('Monitoring is available'), findsOneWidget);
    expect(tester.takeException(), isNull);
    Tooltip.dismissAllToolTips();
    await tester.pumpAndSettle();
  });
}
