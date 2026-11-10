import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'package:flutter/services.dart';
import '../theme/motion.dart';
import 'motion.dart';

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
///
/// "Submit Proof & Complete Delivery" opens it BEFORE anything is uploaded, so
/// the previews may be the rider's local photos ([proofImage]/[invoiceImage])
/// rather than recorded URLs, and [progress]/[progressText] narrate the upload,
/// record and completion steps while [onConfirm] runs.
class CompleteDeliveryConfirmSheet extends StatefulWidget {
  const CompleteDeliveryConfirmSheet({
    super.key,
    required this.orderNumber,
    required this.destinationTitle,
    this.destinationSubtitle,
    this.proofImageUrl,
    this.invoiceImageUrl,
    this.proofImage,
    this.invoiceImage,
    required this.onConfirm,
    this.title = 'Complete this delivery?',
    this.confirmLabel = 'Confirm Delivery',
    this.progress,
    this.progressText,
    this.progressFraction,
    this.offlineAvailable,
    this.onSaveOffline,
  }) : assert(proofImageUrl != null || proofImage != null),
       assert(invoiceImageUrl != null || invoiceImage != null);

  final String orderNumber;
  final String destinationTitle;
  final String? destinationSubtitle;

  /// Canonical Storage download URLs already recorded on the order.
  final String? proofImageUrl;
  final String? invoiceImageUrl;

  /// Previews supplied directly — the rider's local photos, before upload.
  /// Take precedence over the URLs. Never shown as a path.
  final ImageProvider? proofImage;
  final ImageProvider? invoiceImage;

  final String title;
  final String confirmLabel;

  /// Optional live progress while [onConfirm] runs (e.g. the submission
  /// controller): the sheet rebuilds on [progress] and shows [progressText].
  final Listenable? progress;
  final String? Function()? progressText;

  /// 0..1 for the progress bar under [progressText]; null shows no bar.
  final double? Function()? progressFraction;

  /// No signal: after a failure that was only a lost connection
  /// ([offlineAvailable] says so), offer [onSaveOffline] right here — keep the
  /// delivery on the phone and send it later. The sheet closes (false) once
  /// it is saved; a failure to save stays shown.
  final bool Function()? offlineAvailable;
  final Future<void> Function()? onSaveOffline;

  /// Runs the trusted completion. Resolves on authoritative success; throws with
  /// a rider-facing message on failure.
  final Future<void> Function() onConfirm;

  @override
  State<CompleteDeliveryConfirmSheet> createState() =>
      _CompleteDeliveryConfirmSheetState();
}

class _CompleteDeliveryConfirmSheetState
    extends State<CompleteDeliveryConfirmSheet>
    with SingleTickerProviderStateMixin {
  bool _submitting = false;
  bool _savingOffline = false;
  String? _error;

  /// The server confirmed the completion: the sheet shows the delivered mark,
  /// then closes by itself when [_delivered] finishes.
  bool _done = false;
  late final AnimationController _delivered;

  @override
  void initState() {
    super.initState();
    _delivered = AnimationController(vsync: this);
  }

  @override
  void dispose() {
    _delivered.dispose();
    super.dispose();
  }

  /// The one moment that earns more than a snackbar: the rider sees (and
  /// feels) that the delivery is done before the sheet closes. With
  /// animations off the mark is drawn complete and held briefly.
  Future<void> _showDelivered() async {
    _delivered.duration = Motion.reduced(context)
        ? const Duration(milliseconds: 600)
        : Motion.focal;
    setState(() => _done = true);
    HapticFeedback.mediumImpact();
    await _delivered.forward();
  }

  Future<void> _saveOffline() async {
    if (_submitting || _savingOffline) return;
    setState(() => _savingOffline = true);
    try {
      await widget.onSaveOffline!();
      if (mounted) Navigator.of(context).pop(false);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _savingOffline = false;
        _error = _messageFor(e);
      });
    }
  }

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
      await _showDelivered();
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

  Widget _errorBox(String message) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: AppColors.urgentBg,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.error_outline, size: 18, color: AppColors.urgent),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            style: const TextStyle(fontSize: 12, color: AppColors.urgent),
          ),
        ),
      ],
    ),
  );

  /// What the sheet shows once the server confirms the completion.
  Widget _deliveredView() => Padding(
    key: const ValueKey('confirm-sheet-delivered'),
    padding: const EdgeInsets.symmetric(vertical: 28),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DeliveredMark(progress: _delivered),
          const SizedBox(height: 6),
          Text(
            'Order ${widget.orderNumber}',
            style: const TextStyle(fontSize: 13, color: AppColors.textMedium),
          ),
        ],
      ),
    ),
  );

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
          child: _done
              ? _deliveredView()
              : SingleChildScrollView(
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
                      Text(
                        widget.title,
                        style: const TextStyle(
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
                        style: const TextStyle(
                          fontSize: 13,
                          color: AppColors.textLight,
                        ),
                      ),
                      if ((widget.destinationSubtitle ?? '').isNotEmpty)
                        Text(
                          widget.destinationSubtitle!,
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppColors.textMuted,
                          ),
                        ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: _EvidenceThumb(
                              label: 'Proof of delivery',
                              image:
                                  widget.proofImage ??
                                  NetworkImage(widget.proofImageUrl!),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: _EvidenceThumb(
                              label: 'Invoice',
                              image:
                                  widget.invoiceImage ??
                                  NetworkImage(widget.invoiceImageUrl!),
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
                            Icon(
                              Icons.warning_amber_rounded,
                              size: 18,
                              color: AppColors.warning,
                            ),
                            SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                'Completing settles this order\'s stock and cannot be '
                                'casually reversed. Only confirm once the vaccines have '
                                'been handed over.',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: AppColors.warning,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (_submitting && widget.progressText != null)
                        ListenableBuilder(
                          listenable: widget.progress ?? const _NoChange(),
                          builder: (context, _) {
                            final text = widget.progressText!();
                            if (text == null) return const SizedBox.shrink();
                            return Padding(
                              padding: const EdgeInsets.only(top: 12),
                              child: SubmissionProgress(
                                text: text,
                                fraction: widget.progressFraction?.call(),
                                textKey: const ValueKey(
                                  'confirm-sheet-progress',
                                ),
                              ),
                            );
                          },
                        ),
                      FeedbackReveal(
                        identity: _error,
                        child: _error == null
                            ? null
                            : Padding(
                                padding: const EdgeInsets.only(top: 12),
                                child: _errorBox(_error!),
                              ),
                      ),
                      if (_error != null) ...[
                        if (widget.onSaveOffline != null &&
                            (widget.offlineAvailable?.call() ?? false)) ...[
                          const SizedBox(height: 10),
                          SizedBox(
                            width: double.infinity,
                            child: OutlinedButton.icon(
                              key: const ValueKey('confirm-sheet-save-offline'),
                              onPressed: _savingOffline ? null : _saveOffline,
                              icon: _savingOffline
                                  ? const SizedBox(
                                      height: 16,
                                      width: 16,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Icon(Icons.save_alt),
                              label: Text(
                                _savingOffline
                                    ? 'Getting your GPS position…'
                                    : 'No signal? Save on phone and send later',
                              ),
                              style: OutlinedButton.styleFrom(
                                minimumSize: const Size.fromHeight(46),
                              ),
                            ),
                          ),
                          const Padding(
                            padding: EdgeInsets.only(top: 6),
                            child: Text(
                              'VaxTrack records where you are now and sends everything when you are back online. '
                              'The server checks your position against the clinic area before completing it.',
                              style: TextStyle(
                                fontSize: 11,
                                color: AppColors.textLight,
                              ),
                            ),
                          ),
                        ],
                      ],
                      const SizedBox(height: 20),
                      // A matched pair: equal widths (Expanded), equal heights
                      // (IntrinsicHeight + stretch, so if a large text size wraps
                      // one label both buttons grow together and their edges stay
                      // aligned), and one shared size/padding/type so the labels
                      // sit centred the same way in each.
                      IntrinsicHeight(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Expanded(
                              child: OutlinedButton(
                                onPressed: _submitting
                                    ? null
                                    : () => Navigator.of(context).pop(false),
                                style: OutlinedButton.styleFrom(
                                  minimumSize: _actionMinSize,
                                  padding: _actionPadding,
                                  textStyle: _actionTextStyle,
                                ),
                                child: const Text(
                                  'Go Back',
                                  textAlign: TextAlign.center,
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: ElevatedButton(
                                onPressed: _submitting ? null : _confirm,
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: AppColors.primary,
                                  foregroundColor: Colors.white,
                                  minimumSize: _actionMinSize,
                                  padding: _actionPadding,
                                  textStyle: _actionTextStyle,
                                ),
                                child: _submitting
                                    ? const SizedBox(
                                        height: 20,
                                        width: 20,
                                        child: CircularProgressIndicator(
                                          color: Colors.white,
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : Text(
                                        widget.confirmLabel,
                                        textAlign: TextAlign.center,
                                      ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
        ),
      ),
    );
  }
}

// Shared by both sheet actions. Each button is half of a 360 dp phone less
// the 20 dp margins and 12 dp gap: 154 dp. With the theme's 24 dp side padding
// "Submit & Complete" (≈130 dp in Roboto Bold 15) had only 106 dp and wrapped;
// 8 dp leaves 138 dp, so it sits on one line. Narrower phones or larger text
// still wrap it — the IntrinsicHeight pair then grows both buttons together.
const Size _actionMinSize = Size(0, 52);
const EdgeInsets _actionPadding = EdgeInsets.symmetric(
  horizontal: 8,
  vertical: 12,
);
const TextStyle _actionTextStyle = TextStyle(
  fontSize: 15,
  fontWeight: FontWeight.w700,
);

/// A Listenable that never fires, for when no progress source is given.
class _NoChange implements Listenable {
  const _NoChange();
  @override
  void addListener(VoidCallback listener) {}
  @override
  void removeListener(VoidCallback listener) {}
}

class _EvidenceThumb extends StatelessWidget {
  const _EvidenceThumb({required this.label, required this.image});

  final String label;
  final ImageProvider image;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: AppColors.textMedium,
          ),
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image(
            image: image,
            height: 110,
            width: double.infinity,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => Container(
              height: 110,
              color: AppColors.background,
              alignment: Alignment.center,
              child: const Icon(
                Icons.image_not_supported_outlined,
                color: AppColors.textMuted,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
