import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/screens/proof_screen.dart';
import 'package:vaxtrack_mobile/screens/proof_submission_controller.dart';
import 'package:vaxtrack_mobile/services/delivery_service.dart';
import 'package:vaxtrack_mobile/services/image_upload_service.dart';
import 'package:vaxtrack_mobile/services/proof_service.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/utils/order_workflow.dart';
import 'package:vaxtrack_mobile/utils/proof_eligibility.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';
import 'package:vaxtrack_mobile/widgets/delivered_evidence_card.dart';
import 'package:vaxtrack_mobile/widgets/order_number_text.dart';
import 'package:vaxtrack_mobile/widgets/proof_order_selector.dart';

/// Which deliveries the Proof screen offers, how a selection is resolved, and
/// how a stale attempt is stopped — the screen-side filtering AND the
/// controller's fresh-read guard (the server and rules refuse independently).

const me = 'KuLC21dXAOaxM7witdJ2dFLKaRo1';
const otherRider = 'someOtherRiderUid';
const longNumber = 'VT-ORD-17910141845935-59WI';

Delivery order(
  String id, {
  String status = 'in_transit',
  String? rider = me,
  String number = longNumber,
  String? doctor = 'Dr. Ana Reyes',
  String? destination = 'Laguna Provincial Hospital Annex',
  String address = '1234 National Highway corner Rizal Ave, Brgy. San Isidro',
  String priority = 'Standard',
  bool recorded = false,
}) {
  final at = DateTime(2026, 10, 5);
  return Delivery(
    id: id,
    orderNumber: number,
    clinicName: '${doctor ?? 'Unknown'} — ${destination ?? 'Clinic'}',
    clinicAddress: address,
    doctorName: doctor,
    destinationName: destination,
    vaccineName: 'Vaccine',
    quantity: 10,
    unit: 'vials',
    priority: priority,
    status: status,
    statusLabel: {
          'in_transit': 'In Transit',
          'delayed': 'Delayed',
          'delivered': 'Delivered',
          'completed': 'Delivered',
          'cancelled': 'Cancelled',
          'delivery_failed': 'Delivery Failed',
          'assigned': 'Assigned',
          'loading': 'Loading',
        }[status] ??
        status,
    assignedRiderId: rider,
    proofOfDeliveryUrl: recorded ? 'https://storage/$id/proof.jpg' : null,
    proofOfDeliveryPath: recorded ? proofObjectPath(id) : null,
    proofSubmittedAt: recorded ? at : null,
    proofRecipientName: recorded ? 'Maria' : null,
    invoiceUrl: recorded ? 'https://storage/$id/invoice.jpg' : null,
    invoicePath: recorded ? invoiceObjectPath(id) : null,
    invoiceSubmittedAt: recorded ? at : null,
  );
}

List<String> ids(Iterable<Delivery> ds) => ds.map((d) => d.id).toList();

// ------------------------------------------------------------ fakes

/// The server geofence preflight, always eligible here: these tests are about
/// evidence and completion. test/delivery_geofence_test.dart covers refusals.
class _InsideClinic implements DeliveryGeofenceChecker {
  @override
  Future<DeliveryGeofenceResult> checkDeliveryGeofence(String orderId) async =>
      const DeliveryGeofenceResult(eligible: true, distanceM: 12, radiusM: 300, locationAgeSeconds: 20, accuracyM: 8);
}

class _Log {
  final List<String> calls = [];
}

class _Uploader implements ProofUploader {
  _Uploader(this.log);
  final _Log log;
  Completer<void>? gate;
  @override
  Future<EvidenceUpload> uploadProof(String id, File file) async {
    log.calls.add('upload-proof');
    if (gate != null) await gate!.future;
    return EvidenceUpload(downloadUrl: 'https://s/$id/proof.jpg', storagePath: proofObjectPath(id));
  }

  @override
  Future<EvidenceUpload> uploadInvoice(String id, File file) async {
    log.calls.add('upload-invoice');
    return EvidenceUpload(downloadUrl: 'https://s/$id/invoice.jpg', storagePath: invoiceObjectPath(id));
  }

  @override
  Future<String?> existingProofUrl(String id) async => null;
  @override
  Future<String?> existingInvoiceUrl(String id) async => null;
}

class _Writer implements ProofMetadataWriter {
  _Writer(this.log);
  final _Log log;
  @override
  Future<void> saveProofOfDelivery({
    required String orderId,
    required String recipientName,
    required String proofUrl,
    String? storagePath,
  }) async =>
      log.calls.add('record-proof');
  @override
  Future<void> saveInvoicePhoto({required String orderId, required String invoiceUrl, String? storagePath}) async =>
      log.calls.add('record-invoice');
}

class _Completer implements DeliveryCompleter {
  _Completer(this.log);
  final _Log log;
  final List<Object?> results = [];
  @override
  Future<void> markDelivered(String id, String currentStatus) async {
    log.calls.add('complete:$id');
    final next = results.isEmpty ? null : results.removeAt(0);
    if (next != null) throw next;
  }
}

/// The authoritative re-read. Each call returns [current] (or throws [error]).
class _Loader implements DeliveryLoader {
  _Loader(this.log, this.current);
  final _Log log;
  Delivery current;
  Object? error;
  @override
  Future<Delivery> fetchDelivery(String orderId) async {
    log.calls.add('fetch:$orderId');
    if (error != null) throw error!;
    return current;
  }
}

void main() {
  // ---------------------------------------------------------------- 1–4 eligibility

  group('the submission selector offers only completable deliveries', () {
    final all = [
      order('transit', status: 'in_transit'),
      order('delayed', status: 'delayed'),
      order('delivered', status: 'delivered'),
      order('legacyCompleted', status: 'completed'),
      order('cancelled', status: 'cancelled'),
      order('failed', status: 'delivery_failed'),
      order('assigned', status: 'assigned'),
      order('loading', status: 'loading'),
      order('theirs', status: 'in_transit', rider: otherRider),
      order('unassigned', status: 'in_transit', rider: null),
    ];
    final eligible = ids(proofEligibleOrders(all, riderUid: me));

    test('1. delivered (and legacy "completed") orders never appear', () {
      expect(eligible, isNot(contains('delivered')));
      expect(eligible, isNot(contains('legacyCompleted')));
    });

    test('2. cancelled and failed orders never appear', () {
      expect(eligible, isNot(contains('cancelled')));
      expect(eligible, isNot(contains('failed')));
    });

    test('3. eligible In Transit (and Delayed) orders appear; not-yet-dispatched do not', () {
      expect(eligible, ['transit', 'delayed']);
    });

    test("4. only the authenticated rider's assigned orders appear", () {
      expect(eligible, isNot(contains('theirs')));
      expect(eligible, isNot(contains('unassigned')));
      expect(proofEligibleOrders(all, riderUid: otherRider).map((d) => d.id), ['theirs']);
      expect(proofEligibleOrders(all, riderUid: null), isEmpty, reason: 'signed out: nothing');
      expect(proofEligibleOrders(all, riderUid: ''), isEmpty);
      // An exact comparison: a padded uid is a different uid.
      expect(proofEligibleOrders(all, riderUid: ' $me'), isEmpty);
    });

    test('each ineligible case has its own reason', () {
      ProofIneligibility? r(String id) =>
          proofIneligibility(all.firstWhere((d) => d.id == id), riderUid: me);
      expect(r('transit'), isNull);
      expect(r('delivered'), ProofIneligibility.completed);
      expect(r('legacyCompleted'), ProofIneligibility.completed);
      expect(r('cancelled'), ProofIneligibility.cancelled);
      expect(r('failed'), ProofIneligibility.failed);
      expect(r('assigned'), ProofIneligibility.notReady);
      expect(r('theirs'), ProofIneligibility.notAssignedToYou);
      expect(proofIneligibility(null, riderUid: me), ProofIneligibility.notFound);
      expect(proofIneligibilityMessage(ProofIneligibility.completed), contains('already been completed'));
    });
  });

  // ---------------------------------------------------------------- 5–7 navigation identity

  group('navigation uses the Firestore document id', () {
    test('5. ProofScreen.forDelivery carries the document id, never the order number', () {
      final d = order('UcwuVXjlBAzZuYMKeHK0', number: 'VT-ORD-1791190448932-UCWU');
      final screen = ProofScreen.forDelivery(d);
      expect(screen.initialOrderId, 'UcwuVXjlBAzZuYMKeHK0');
      expect(screen.initialOrderId, isNot(d.orderNumber));
    });

    test('5. every Delivery Detail route to Proof uses forDelivery (Complete and Add proof)', () {
      final src = File('lib/screens/delivery_detail_screen.dart').readAsStringSync();
      final routes = RegExp(r'ProofScreen[.(][^\n]*').allMatches(src).map((m) => m.group(0)).toList();
      expect(routes, hasLength(2), reason: 'Submit Proof & Complete Delivery, and Add proof');
      for (final r in routes) {
        expect(r, startsWith('ProofScreen.forDelivery(d)'), reason: r);
      }
      expect(src.contains('const ProofScreen()'), isFalse, reason: 'no generic, unselected Proof screen');
    });

    test('6. the requested order is selected automatically', () {
      final ds = [order('a'), order('b', number: 'VT-ORD-2'), order('c', number: 'VT-ORD-3')];
      final s = resolveProofSelection(deliveries: ds, riderUid: me, selectedId: 'b');
      expect(s.selected!.id, 'b');
      expect(s.blockedReason, isNull);
    });

    test('7. duplicate-looking order numbers cannot select the wrong document', () {
      final ds = [
        order('docA', number: 'VT-ORD-1791190448932-UCWU', destination: 'Clinic A'),
        order('docB', number: 'VT-ORD-1791190448932-UCWU', destination: 'Clinic B'),
      ];
      expect(resolveProofSelection(deliveries: ds, riderUid: me, selectedId: 'docB').selected!.destinationName,
          'Clinic B');
      expect(resolveProofSelection(deliveries: ds, riderUid: me, selectedId: 'docA').selected!.destinationName,
          'Clinic A');
      expect(duplicateOrderNumbers(ds), {'VT-ORD-1791190448932-UCWU'});
    });
  });

  // ---------------------------------------------------------------- 8–9 stale states

  group('a delivery that closes is locked and removed', () {
    test('8. becoming Delivered while open: no selection, completed reason, not a choice', () {
      final before = resolveProofSelection(deliveries: [order('x'), order('y', number: 'VT-2')], riderUid: me, selectedId: 'x');
      expect(before.selected!.id, 'x');

      final after = resolveProofSelection(
        deliveries: [order('x', status: 'delivered'), order('y', number: 'VT-2')],
        riderUid: me,
        selectedId: 'x',
      );
      expect(after.selected, isNull, reason: 'submission disabled');
      expect(after.blockedReason, ProofIneligibility.completed);
      expect(ids(after.eligible), ['y'], reason: 'removed from the choices');
    });

    test('9. a stale direct-navigation id never falls back to another order', () {
      final ds = [
        order('open'),
        order('gone', status: 'cancelled'),
        order('theirs', rider: otherRider),
      ];
      for (final (id, reason) in [
        ('gone', ProofIneligibility.cancelled),
        ('theirs', ProofIneligibility.notAssignedToYou),
        ('missing', ProofIneligibility.notFound),
      ]) {
        final s = resolveProofSelection(deliveries: ds, riderUid: me, selectedId: id);
        expect(s.selected, isNull, reason: id);
        expect(s.blockedReason, reason, reason: id);
        expect(ids(s.eligible), ['open'], reason: '$id: the open order stays a CHOICE, never auto-selected');
      }
    });
  });

  group("the controller's fresh read stops stale attempts before any upload", () {
    late _Log log;
    late _Loader loader;
    late _Completer completer;
    late ProofSubmissionController c;
    final photo = File('p.jpg');
    final invoice = File('i.jpg');

    setUp(() {
      log = _Log();
      loader = _Loader(log, order('o1'));
      completer = _Completer(log);
      c = ProofSubmissionController(
        uploader: _Uploader(log),
        writer: _Writer(log),
        completer: completer,
        loader: loader,
        geofence: _InsideClinic(),
      );
    });

    Future<bool> submit({String status = 'in_transit'}) => c.submitAndComplete(
          orderId: 'o1',
          currentStatus: status,
          proofRecorded: false,
          invoiceRecorded: false,
          recipientName: 'Maria Santos',
          proofPhoto: photo,
          invoicePhoto: invoice,
          riderUid: me,
        );

    test('8. already Delivered on the server: no upload, no completion, locked', () async {
      loader.current = order('o1', status: 'delivered', recorded: true);
      expect(await submit(), isFalse);
      expect(log.calls, ['fetch:o1'], reason: 'nothing uploaded, recorded or completed');
      expect(c.isAlreadyCompleted, isTrue);
      expect(c.errorMessage, ProofSubmissionController.alreadyCompletedMessage);
      expect(
          c.canSubmitAndComplete(
              recipientName: 'M', hasProofPhoto: true, hasInvoicePhoto: true, proofRecorded: false, invoiceRecorded: false),
          isFalse);
      // Further taps do nothing at all.
      expect(await submit(), isFalse);
      expect(log.calls, ['fetch:o1']);
    });

    test('9. cancelled, failed, reassigned or not-ready: refused with the reason, nothing uploaded', () async {
      for (final (d, text) in [
        (order('o1', status: 'cancelled'), 'cancelled'),
        (order('o1', status: 'delivery_failed'), 'reported as failed'),
        (order('o1', rider: otherRider), 'no longer assigned to you'),
        (order('o1', status: 'loading'), 'not out for delivery'),
      ]) {
        log.calls.clear();
        loader.current = d;
        expect(await submit(), isFalse, reason: d.status);
        expect(log.calls, ['fetch:o1'], reason: d.status);
        expect(c.errorMessage, contains(text));
      }
    });

    test('the order cannot be confirmed (offline): refused before any upload', () async {
      loader.error = const SocketException('offline');
      expect(await submit(), isFalse);
      expect(log.calls, ['fetch:o1']);
      expect(c.errorMessage, ProofSubmissionController.refreshFailedMessage);
    });

    test('12. eligible: uploads, records, completes; then the order leaves the choices', () async {
      expect(await submit(), isTrue);
      expect(log.calls, ['fetch:o1', 'upload-proof', 'upload-invoice', 'record-proof', 'record-invoice', 'complete:o1']);
      final after = resolveProofSelection(
          deliveries: [order('o1', status: 'delivered', recorded: true)], riderUid: me, selectedId: 'o1');
      expect(after.eligible, isEmpty);
      expect(after.blockedReason, ProofIneligibility.completed);
    });

    test('the fresh read knows better than the screen: recorded evidence is not re-uploaded', () async {
      loader.current = order('o1', recorded: true);
      expect(await submit(), isTrue);
      expect(log.calls, ['fetch:o1', 'complete:o1']);
    });

    test('13. completion fails after uploads: the retry reuses them — no new upload or record', () async {
      completer.results.add(const WorkflowException('unavailable', 'UNAVAILABLE'));
      expect(await submit(), isFalse);
      expect(c.isCompletionPending, isTrue);
      expect(c.errorMessage, ProofSubmissionController.completionPendingMessage);
      // The server now has both photos recorded.
      loader.current = order('o1', recorded: true);
      log.calls.clear();
      expect(await submit(), isTrue);
      expect(log.calls, ['fetch:o1', 'complete:o1']);
    });

    test('14. repeated taps make one fetch, one of each upload and one completion call', () async {
      final up = _Uploader(log)..gate = Completer<void>();
      c = ProofSubmissionController(uploader: up, writer: _Writer(log), completer: completer, loader: loader, geofence: _InsideClinic());
      final taps = List.generate(5, (_) => submit());
      up.gate!.complete();
      final results = await Future.wait(taps);
      expect(results.where((r) => r).length, 1);
      expect(log.calls.where((x) => x == 'fetch:o1').length, 1);
      expect(log.calls.where((x) => x == 'upload-proof').length, 1);
      expect(log.calls.where((x) => x == 'upload-invoice').length, 1);
      expect(log.calls.where((x) => x == 'complete:o1').length, 1);
      // ...and once completed, another tap is a no-op success: no call at all.
      final before = List.of(log.calls);
      expect(await submit(), isTrue);
      expect(log.calls, before);
    });
  });

  // ---------------------------------------------------------------- 10–11 the selector UI

  group('the selector on narrow phones', () {
    Future<void> pump(WidgetTester tester, Widget child, {double width = 360, double height = 800, double textScale = 1}) async {
      tester.view.physicalSize = Size(width * 2, height * 2);
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.theme,
        home: MediaQuery.withClampedTextScaling(
          minScaleFactor: textScale,
          maxScaleFactor: textScale,
          child: Scaffold(body: ListView(padding: const EdgeInsets.all(16), children: [child])),
        ),
      ));
    }

    void expectWhole(WidgetTester tester, String number, {int count = 1}) {
      final finder = find.text(number);
      expect(finder, findsNWidgets(count));
      for (final p in tester.renderObjectList<RenderParagraph>(finder)) {
        expect(p.didExceedMaxLines, isFalse, reason: 'not cut off');
      }
      for (final t in tester.widgetList<Text>(finder)) {
        expect(t.maxLines, 1);
        expect(t.overflow, isNot(TextOverflow.ellipsis));
      }
      final screen = tester.view.physicalSize.width / tester.view.devicePixelRatio;
      for (final e in finder.evaluate()) {
        final r = tester.getRect(find.byWidget(e.widget));
        expect(r.left, greaterThanOrEqualTo(0));
        expect(r.right, lessThanOrEqualTo(screen), reason: 'no horizontal overflow');
      }
    }

    // The vivo V2419 report: a 720×1600 panel at density 2.0 → 360×800 dp.
    // 320 dp covers the same phone with a larger display-size setting.
    for (final (label, width, scale) in [
      ('vivo V2419 360dp', 360.0, 1.0),
      ('vivo V2419 360dp, text 1.3×', 360.0, 1.3),
      ('320dp, text 1.6×', 320.0, 1.6),
    ]) {
      testWidgets('10/11. items show full number, doctor, destination and status — $label', (tester) async {
        final eligible = [
          order('a', number: 'VT-ORD-17910141845935-59WI', priority: 'Urgent'),
          order('b', number: 'VT-ORD-17910141845935-60XJ', destination: 'Sta. Rosa Medical Center', status: 'delayed'),
        ];
        String? picked;
        await pump(tester, ProofOrderSelector(eligible: eligible, selectedId: null, onSelected: (id) => picked = id),
            width: width, textScale: scale);

        expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');
        // Long numbers differing only at the end stay whole, so they stay apart.
        expectWhole(tester, 'VT-ORD-17910141845935-59WI');
        expectWhole(tester, 'VT-ORD-17910141845935-60XJ');
        expect(find.text('Dr. Ana Reyes · Laguna Provincial Hospital Annex'), findsOneWidget);
        expect(find.text('Dr. Ana Reyes · Sta. Rosa Medical Center'), findsOneWidget);
        expect(find.text('In Transit'), findsOneWidget);
        expect(find.text('Delayed'), findsOneWidget);
        expect(find.text('Urgent'), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('proof-order-b')));
        expect(picked, 'b', reason: 'selection reports the document id');
      });
    }

    testWidgets('7. identical order numbers are told apart by a document reference', (tester) async {
      final eligible = [
        order('docAAAA111111', number: longNumber),
        order('docBBBB222222', number: longNumber),
      ];
      String? picked;
      await pump(tester, ProofOrderSelector(eligible: eligible, selectedId: null, onSelected: (id) => picked = id));
      expect(find.text('Ref …111111'), findsOneWidget);
      expect(find.text('Ref …222222'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('proof-order-docBBBB222222')));
      expect(picked, 'docBBBB222222');
    });

    testWidgets('the selector has a real empty state', (tester) async {
      await pump(tester, ProofOrderSelector(eligible: const [], selectedId: null, onSelected: (_) {}));
      expect(find.byKey(const ValueKey('proof-selector-empty')), findsOneWidget);
      expect(find.text('No deliveries need proof right now'), findsOneWidget);
    });

    testWidgets('a disabled selector (mid-submission) ignores taps', (tester) async {
      String? picked;
      await pump(tester, ProofOrderSelector(eligible: [order('a')], selectedId: null, onSelected: (id) => picked = id, enabled: false));
      await tester.tap(find.byKey(const ValueKey('proof-order-a')));
      expect(picked, isNull);
    });

    for (final (label, width, scale) in [('vivo V2419 360dp', 360.0, 1.0), ('320dp, text 1.6×', 320.0, 1.6)]) {
      testWidgets('6/7. the selected order is shown in full for verification — $label', (tester) async {
        await pump(tester, ProofOrderSummary(delivery: order('a'), onChange: () {}), width: width, textScale: scale);
        expect(tester.takeException(), isNull);
        expectWhole(tester, longNumber);
        expect(find.text('Dr. Ana Reyes'), findsOneWidget);
        expect(find.text('Laguna Provincial Hospital Annex'), findsOneWidget);
        expect(find.text('1234 National Highway corner Rizal Ave, Brgy. San Isidro'), findsOneWidget);
        expect(find.text('In Transit'), findsOneWidget);
        expect(find.byType(OrderNumberText), findsOneWidget);
      });
    }

    testWidgets('an older order without a doctor still verifies cleanly', (tester) async {
      await pump(tester, ProofOrderSummary(delivery: order('a', doctor: null, destination: null)));
      expect(find.text('Not recorded'), findsOneWidget);
      expect(find.text('Unknown — Clinic'), findsOneWidget);
    });
  });

  group("a delivered order's evidence stays viewable, read-only", () {
    testWidgets('proof, recipient and invoice are shown — with no action', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.theme,
        home: Scaffold(
          body: ListView(children: [
            DeliveredEvidenceCard(delivery: order('d', status: 'delivered', recorded: true)),
          ]),
        ),
      ));
      expect(find.text('Proof of delivery'), findsOneWidget);
      expect(find.text('Received by Maria'), findsOneWidget);
      expect(find.text('Invoice photo'), findsOneWidget);
      expect(find.byType(Image), findsNWidgets(2));
      expect(find.byType(ElevatedButton), findsNothing);
      expect(find.byType(TextButton), findsNothing);
    });

    testWidgets('a delivered order without proof says so and offers nothing to add', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: DeliveredEvidenceCard(delivery: order('d', status: 'delivered'))),
      ));
      expect(find.textContaining('Proof unavailable'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    });
  });
}
