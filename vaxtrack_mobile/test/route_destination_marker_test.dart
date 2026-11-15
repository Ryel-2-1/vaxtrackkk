import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

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
}
