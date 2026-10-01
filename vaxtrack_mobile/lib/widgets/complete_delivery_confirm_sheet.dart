import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// Final confirmation before a Rider completes a delivery.
///
/// Completion settles inventory on the server and cannot be casually reversed,
/// so this sheet is the deliberate second step between the tap and the trusted
/// call. It shows what is about to be settled — the order, its destination, and
/// the two evidence photos already recorded — and asks for an explicit confirm.
///
/// It OWNS the submission lifecycle so the destructive action is safe:
///   * the confirm button is disabled and shows a spinner while [onConfirm] runs;
///   * repeated taps cannot start a second submission (a synchronous guard);
///   * on success it pops with `true` — the caller shows the completed state
///     only then, never before the awaited [onConfirm] resolves;
///   * on failure it stays open, shows the server's message, and re-enables the
///     button so the rider can retry.
///
/// [onConfirm] performs the real completion and throws on failure. This widget
/// contains no Firebase or upload code, so it is exercised in a widget test with
/// a plain fake callback.
class CompleteDeliveryConfirmSheet extends StatefulWidget {
  const CompleteDeliveryConfirmSheet({
    super.key,
    required this.orderNumber,
    required this.destinationTitle,
    this.destinationSubtitle,
    required this.proofImageUrl,
    required this.invoiceImageUrl,
    required this.onConfirm,
  });

  final String orderNumber;
  final String destinationTitle;
  final String? destinationSubtitle;

  /// Canonical Storage download URLs already recorded on the order. Only URLs are
  /// shown — never a local file path.
  final String proofImageUrl;
  final String invoiceImageUrl;

  /// Runs the trusted completion. Resolves on authoritative success; throws with
  /// a rider-facing message on failure.
  final Future<void> Function() onConfirm;

  @override
  State<CompleteDeliveryConfirmSheet> createState() =>
      _CompleteDeliveryConfirmSheetState();
}

class _CompleteDeliveryConfirmSheetState
    extends State<CompleteDeliveryConfirmSheet> {
  bool _submitting = false;
  String? _error;

  Future<void> _confirm() async {
    // Synchronous guard: several taps in one event turn all arrive before the
    // rebuild that disables the button, so this is what makes them one call.
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.onConfirm();
      if (!mounted) return;
      Navigator.of(context).pop(true); // success — caller may show completed
    } catch (e) {
      if (!mounted) return;
      // Do NOT claim completion. Stay open, surface the message, allow retry.
      setState(() {
        _submitting = false;
        _error = _messageFor(e);
      });
    }
  }

  String _messageFor(Object error) {
    // The service already writes a rider-facing sentence for domain failures;
    // strip any leading "SomethingException: " or "WorkflowException(code): "
    // wrapper so the rider sees the sentence, not the class name.
    final text = error
        .toString()
        .replaceFirst(RegExp(r'^[A-Za-z]+Exception(\([^)]*\))?:\s*'), '')
        .trim();
    return text.isEmpty
        ? 'Could not complete the delivery. Please try again.'
        : text;
  }

  @override
  Widget build(BuildContext context) {
    // Android back safely dismisses (as "Go Back") — but never mid-submission,
    // so a half-finished completion is not abandoned.
    return PopScope(
      canPop: !_submitting,
      child: SafeArea(
        child: Padding(
          padding: EdgeInsets.only(
            left: 20,
            right: 20,
            top: 16,
            bottom: 16 + MediaQuery.of(context).viewInsets.bottom,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    margin: const EdgeInsets.only(bottom: 16),
                    decoration: BoxDecoration(
                      color: AppColors.border,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const Text(
                  'Complete this delivery?',
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textDark,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Order ${widget.orderNumber}',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textMedium,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  widget.destinationTitle,
                  style: const TextStyle(fontSize: 13, color: AppColors.textLight),
                ),
                if ((widget.destinationSubtitle ?? '').isNotEmpty)
                  Text(
                    widget.destinationSubtitle!,
                    style:
                        const TextStyle(fontSize: 12, color: AppColors.textMuted),
                  ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: _EvidenceThumb(
                        label: 'Proof of delivery',
                        imageUrl: widget.proofImageUrl,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _EvidenceThumb(
                        label: 'Invoice',
                        imageUrl: widget.invoiceImageUrl,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.warningBg,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.warning_amber_rounded,
                          size: 18, color: AppColors.warning),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Completing settles this order\'s stock and cannot be '
                          'casually reversed. Only confirm once the vaccines have '
                          'been handed over.',
                          style: TextStyle(fontSize: 12, color: AppColors.warning),
                        ),
                      ),
                    ],
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.urgentBg,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.error_outline,
                            size: 18, color: AppColors.urgent),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _error!,
                            style: const TextStyle(
                                fontSize: 12, color: AppColors.urgent),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _submitting
                            ? null
                            : () => Navigator.of(context).pop(false),
                        child: const Text('Go Back'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: ElevatedButton(
                        onPressed: _submitting ? null : _confirm,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppColors.primary,
                          foregroundColor: Colors.white,
                        ),
                        child: _submitting
                            ? const SizedBox(
                                height: 20,
                                width: 20,
                                child: CircularProgressIndicator(
                                    color: Colors.white, strokeWidth: 2),
                              )
                            : const Text('Confirm Delivery'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EvidenceThumb extends StatelessWidget {
  const _EvidenceThumb({required this.label, required this.imageUrl});

  final String label;
  final String imageUrl;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
              fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textMedium),
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.network(
            imageUrl,
            height: 110,
            width: double.infinity,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => Container(
              height: 110,
              color: AppColors.background,
              alignment: Alignment.center,
              child: const Icon(Icons.image_not_supported_outlined,
                  color: AppColors.textMuted),
            ),
          ),
        ),
      ],
    );
  }
}
