import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:vaxtrack_mobile/widgets/route_stop_pin.dart';

/// SUPPLEMENTARY source guard (the route screen needs a live map and GPS, so
/// no widget test renders it). On a phone with a larger system font, the
/// destination marker's name chip grew past its fixed 76 px box and Flutter
/// drew "BOTTOM OVERFLOWED" across the map (2026-11-15). The box now has room
/// for the chip at its capped text size, and the chip can only shrink.
void main() {
  final src = File('lib/screens/route_monitoring_screen.dart').readAsStringSync().replaceAll('\r\n', '\n');

  test('the destination marker has room for its label and pin', () {
    expect(
      RegExp(r'point: dest,\s*width: 180,\s*height: 96,\s*alignment: Alignment\.topCenter,').hasMatch(src),
      isTrue,
    );
  });

  test('the label can shrink, so the pin never overflows the marker', () {
    expect(src.contains('Flexible(child: _mapChip(_destinationName)),'), isTrue);
  });

  test('map labels follow the phone font size only up to the size the marker allows', () {
    expect(
      RegExp(r'Widget _mapChip\(String text\) => MediaQuery\.withClampedTextScaling\(\s*maxScaleFactor: 1\.3,').hasMatch(src),
      isTrue,
    );
  });

  testWidgets('the route pin stays upright and anchored when the map rotates', (tester) async {
    final controller = MapController();
    const destination = LatLng(14.17, 121.25);
    const pinKey = Key('stop-pin');

    await tester.pumpWidget(MaterialApp(
      home: Center(
        child: SizedBox(
          width: 400,
          height: 400,
          child: FlutterMap(
            mapController: controller,
            options: const MapOptions(initialCenter: destination),
            children: const [
              MarkerLayer(
                rotate: true,
                markers: [
                  Marker(
                    point: destination,
                    width: 40,
                    height: 50,
                    alignment: Alignment.topCenter,
                    child: RouteStopPin(key: pinKey, color: Colors.orange, size: 40),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    ));

    final mapCenter = tester.getCenter(find.byType(FlutterMap));
    for (final degrees in [0.0, 38.0, 135.0]) {
      controller.rotate(degrees);
      await tester.pump();
      final pin = tester.renderObject<RenderBox>(find.byKey(pinKey));
      final tip = pin.localToGlobal(Offset(pin.size.width / 2, pin.size.height));
      final top = pin.localToGlobal(Offset(pin.size.width / 2, 0));
      expect((tip - mapCenter).distance, lessThan(1));
      expect(top.dx, closeTo(tip.dx, 0.01));
      expect(top.dy, closeTo(tip.dy - pin.size.height, 0.01));
    }
  });
}
