import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// SUPPLEMENTARY source guard (the proof screen needs Firebase and a camera,
/// so no widget test renders it). Delivery evidence is photographed at the
/// clinic: the invoice, like the proof, opens the camera straight away and
/// never the phone's gallery (2026-11-15).
void main() {
  final screen = File('lib/screens/proof_screen.dart').readAsStringSync().replaceAll('\r\n', '\n');
  final service = File('lib/services/image_upload_service.dart').readAsStringSync();

  test('tapping the invoice card opens the camera', () {
    final pick = RegExp(r'Future<void> _pickInvoicePhoto\(\) async \{\s*final picked = await _imageService\.(\w+)\(\);')
        .firstMatch(screen);
    expect(pick?.group(1), 'pickFromCamera');
  });

  test('no delivery photo can come from the gallery', () {
    expect(screen.contains('pickFromGallery'), isFalse);
    expect(service.contains('ImageSource.gallery'), isFalse);
  });

  test('the invoice card says to take a photo, not to upload one', () {
    expect(screen.contains("'Upload invoice photo'"), isFalse);
    expect(screen.contains("'Choose another photo'"), isFalse);
    final card = screen.substring(screen.indexOf('Widget _invoiceCard()'));
    expect(card.contains("'Tap to take a photo'"), isTrue);
    expect(card.contains('Icons.camera_alt'), isTrue);
  });
}
