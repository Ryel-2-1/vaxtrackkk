import 'package:flutter/foundation.dart';

import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../utils/completion_gate.dart';
import '../utils/order_workflow.dart';

/// Owns Delivery Detail's view of ONE order for the completion flow.
///
/// The screen used to read `widget.delivery` — a snapshot taken by the
/// dashboard when the screen opened, never refreshed. A rider told "add the
/// proof photo" could add it on Proof of Delivery, come back, and still be told
/// it was missing, because the screen was looking at the old copy. This holds
/// the current order instead, reloads it from the authoritative source when the
/// rider returns from adding evidence, and refuses to vouch for evidence it
/// could not confirm.
///
/// It contains no Firebase code: it talks to a [DeliveryLoader] and a
/// [DeliveryCompleter], which the screen satisfies with [DeliveryService] and
/// tests satisfy with fakes.
class DeliveryCompletionCoordinator extends ChangeNotifier {
  DeliveryCompletionCoordinator({
    required Delivery initial,
    required DeliveryLoader loader,
    required DeliveryCompleter completer,
  })  : _delivery = initial,
        _loader = loader,
        _completer = completer;

  final DeliveryLoader _loader;
  final DeliveryCompleter _completer;

  static const String refreshFailedMessage =
      'Could not load the latest delivery details. Check your connection and '
      'try again.';

  Delivery _delivery;

  /// False once an authoritative reload has FAILED. The previous order stays on
  /// screen, but its evidence and status are not trusted for completion until a
  /// reload succeeds. The order the screen opened with came from the rider's
  /// live list, so it starts confirmed.
  bool _dataConfirmed = true;

  bool _refreshing = false;
  String? _refreshError;
  Future<bool>? _inFlightRefresh;

  /// The completion duplicate guard. Set synchronously before the first await.
  bool _completing = false;

  bool _disposed = false;

  Delivery get delivery => _delivery;
  bool get dataConfirmed => _dataConfirmed;
  bool get refreshing => _refreshing;
  String? get refreshError => _refreshError;
  bool get completing => _completing;

  /// Whether the rider may open the completion confirmation right now.
  CompletionReadiness readiness({required String? currentRiderId}) {
    final d = _delivery;
    return evaluateCompletionReadiness(
      orderId: d.id,
      currentRiderId: currentRiderId,
      assignedRiderId: d.assignedRiderId,
      dataConfirmed: _dataConfirmed,
      statusEligible: d.canComplete,
      hasProof: d.hasProof,
      hasInvoice: d.hasInvoice,
      completionInProgress: _completing,
    );
  }

  /// Reload the order from the authoritative source. Resolves to true when the
  /// fresh copy replaced the old one.
  ///
  /// On failure the previous order is KEPT for display, but marked unconfirmed so
  /// completion stays blocked — newly uploaded evidence is never assumed to
  /// exist. A refresh already running is shared rather than duplicated.
  Future<bool> refresh() {
    return _inFlightRefresh ??=
        _doRefresh().whenComplete(() => _inFlightRefresh = null);
  }

  Future<bool> _doRefresh() async {
    _refreshing = true;
    _refreshError = null;
    _notify();
    try {
      _delivery = await _loader.fetchDelivery(_delivery.id);
      _dataConfirmed = true;
      return true;
    } catch (_) {
      // No error detail is surfaced: it can carry Firebase internals.
      _dataConfirmed = false;
      _refreshError = refreshFailedMessage;
      return false;
    } finally {
      _refreshing = false;
      _notify();
    }
  }

  /// Let the rider add evidence, then reload.
  ///
  /// The reload ALWAYS runs once [openProofScreen] completes — whether or not
  /// anything was uploaded — so completion never relies on the old snapshot.
  Future<bool> addEvidenceThenRefresh(
    Future<void> Function() openProofScreen,
  ) async {
    await openProofScreen();
    return refresh();
  }

  /// Run the trusted completion, one request at a time.
  ///
  /// Throws on re-entry, on unconfirmed data, and on any server failure. It
  /// NEVER marks the order delivered locally: the caller shows the completed
  /// state only after this resolves, and the server stays the authority for the
  /// status and for inventory settlement.
  Future<void> complete() async {
    if (_completing) {
      throw const WorkflowException(
        'in-progress',
        'This delivery is already being completed.',
      );
    }
    if (!_dataConfirmed) {
      throw const WorkflowException('refresh-required', refreshFailedMessage);
    }
    _completing = true;
    _notify();
    try {
      await _completer.markDelivered(_delivery.id, _delivery.status);
    } finally {
      _completing = false;
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
