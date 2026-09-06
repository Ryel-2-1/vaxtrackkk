import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';

void main() {
  group('validateRecipientName', () {
    test('accepts an ordinary name and returns it trimmed', () {
      final result = validateRecipientName('  Maria Santos  ');
      expect(result.valid, isTrue);
      expect(result.value, 'Maria Santos');
    });

    test('rejects empty and whitespace-only input', () {
      for (final input in ['', '   ', '\t', null, 42]) {
        final result = validateRecipientName(input);
        expect(result.valid, isFalse, reason: 'input: $input');
        expect(result.code, 'recipient-required');
      }
    });

    test('preserves ordinary human names across scripts and punctuation', () {
      // Spaces, apostrophes, hyphens, accents, and non-Latin scripts are all
      // ordinary names, not input to be sanitised.
      const names = [
        "O'Brien",
        'Reyes-Cruz',
        'Ma. Luisa Dela Peña',
        'Ñoño Ibañez',
        'Ана Петровић',
        '田中 太郎',
        'Nguyễn Thị Hương',
        'Jean-Luc de la Fontaine',
      ];
      for (final name in names) {
        final result = validateRecipientName(name);
        expect(result.valid, isTrue, reason: name);
        expect(result.value, name);
      }
    });

    test('rejects line breaks and control characters', () {
      for (final input in ['Maria\nSantos', 'Maria\tSantos', 'Maria\u2028Santos',
        'Maria\u000BSantos',
        'Maria\u0085Santos']) {
        final result = validateRecipientName(input);
        expect(result.valid, isFalse, reason: input);
        expect(result.code, 'recipient-invalid-characters');
      }
    });

    group('length boundary', () {
      test('accepts exactly the maximum', () {
        final name = 'a' * kMaxRecipientNameLength;
        expect(name.length, 120);
        expect(validateRecipientName(name).valid, isTrue);
      });

      test('rejects one over the maximum', () {
        final name = 'a' * (kMaxRecipientNameLength + 1);
        final result = validateRecipientName(name);
        expect(result.valid, isFalse);
        expect(result.code, 'recipient-too-long');
      });

      test('measures the TRIMMED value, not the raw input', () {
        // 120 real characters wrapped in padding is a valid 120-char name.
        final padded = '  ${'a' * kMaxRecipientNameLength}  ';
        expect(padded.length, greaterThan(kMaxRecipientNameLength));
        expect(validateRecipientName(padded).valid, isTrue);
      });

      test('counts UTF-16 code units, matching what the rules count', () {
        // 60 astral-plane characters are 120 UTF-16 units. Counting runes here
        // would accept 120 of them and the deployed rules would then refuse the
        // write — the client and the rules have to agree on the unit.
        final astral = '𝒜' * 60;
        expect(astral.length, kMaxRecipientNameLength);
        expect(astral.runes.length, 60);
        expect(validateRecipientName(astral).valid, isTrue);
        expect(validateRecipientName('𝒜' * 61).valid, isFalse);
      });
    });
  });

  group('validateEvidenceSize', () {
    test('accepts a file below the limit', () {
      expect(validateEvidenceSize(kMaxEvidenceBytes - 1).valid, isTrue);
      expect(validateEvidenceSize(1024 * 1024).valid, isTrue);
    });

    test('rejects a file EXACTLY at the limit', () {
      // storage.rules says `size < 10 * 1024 * 1024`, so 10 MB exactly is
      // refused there. The client limit has to be the same strict bound or a
      // photo would upload and then be rejected by the rules.
      expect(kMaxEvidenceBytes, 10 * 1024 * 1024);
      final result = validateEvidenceSize(kMaxEvidenceBytes);
      expect(result.valid, isFalse);
      expect(result.code, 'evidence-too-large');
    });

    test('rejects a file above the limit', () {
      final result = validateEvidenceSize(kMaxEvidenceBytes + 1);
      expect(result.valid, isFalse);
      expect(result.code, 'evidence-too-large');
    });

    test('rejects an empty file', () {
      expect(validateEvidenceSize(0).code, 'evidence-empty');
      expect(validateEvidenceSize(-1).code, 'evidence-empty');
    });
  });

  group('canonical object paths', () {
    test('are built from the Firestore document id', () {
      const docId = 'JDP0JzdWMnegoeAz3Zq9';
      expect(proofObjectPath(docId), 'proof_of_delivery/$docId/proof.jpg');
      expect(invoiceObjectPath(docId), 'invoices/$docId/invoice.jpg');
    });

    test('do NOT use the human order number', () {
      // The order number is a display label; the Storage rules resolve the path
      // segment as a Firestore document id, so using it would never authorize.
      const docId = 'JDP0JzdWMnegoeAz3Zq9';
      const orderNumber = 'VT-ORD-1788246428806';
      expect(proofObjectPath(docId), isNot(contains(orderNumber)));
    });

    test('are stable — the same order always yields the same object', () {
      // The previous convention embedded DateTime.now(), so every retry created
      // another undeletable object.
      expect(proofObjectPath('ord1'), proofObjectPath('ord1'));
      expect(proofObjectPath('ord1'), isNot(proofObjectPath('ord2')));
    });
  });

  group('imageContentTypeFor', () {
    test('maps known image extensions', () {
      expect(imageContentTypeFor('/tmp/a.png'), 'image/png');
      expect(imageContentTypeFor('/tmp/a.WEBP'), 'image/webp');
      expect(imageContentTypeFor('/tmp/a.heic'), 'image/heic');
      expect(imageContentTypeFor('/tmp/a.jpg'), 'image/jpeg');
    });

    test('always returns an image/* type, which is what the rules require', () {
      for (final path in ['/tmp/a', '/tmp/a.bin', '/tmp/a.pdf', '']) {
        expect(imageContentTypeFor(path), startsWith('image/'));
      }
    });
  });

  test('proof is submittable only while in transit or delayed', () {
    expect(kProofSubmittableStatuses, ['in_transit', 'delayed']);
    // delivered is absent on purpose — evidence is gathered during the
    // delivery, not manufactured after it closed.
    expect(kProofSubmittableStatuses, isNot(contains('delivered')));
    expect(kProofSubmittableStatuses, isNot(contains('cancelled')));
  });
}
