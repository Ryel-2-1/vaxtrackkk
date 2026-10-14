import 'dart:io';

import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';

import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/image_upload_service.dart';
import '../services/proof_service.dart';
import '../theme/app_theme.dart';
import '../utils/proof_eligibility.dart';
import '../utils/proof_validation.dart';
import '../widgets/complete_delivery_confirm_sheet.dart';
import '../widgets/proof_order_selector.dart';
import 'proof_submission_controller.dart';

/// Proof of Delivery — and, in the same action, completing the delivery.
///
/// "Submit Proof & Complete Delivery" replaces the old two-step flow (submit
/// proof here, then "Complete Delivery" on Delivery Detail). One tap opens the
/// existing confirmation sheet; once the rider confirms, both photos are
/// uploaded and recorded and the trusted completion callable runs. The order
/// becomes delivered only when that server call succeeds.
///
/// [initialOrderId] preselects a delivery (opened from Delivery Detail). The
/// screen then pops with `true` once the delivery is completed.
///
/// Only deliveries that can still legally take proof and be completed are
/// offered (proof_eligibility.dart). A preselected delivery that is not — or
/// that becomes delivered while the screen is open — is shown as such, with no
/// submission and no silent fallback to another order.
class ProofScreen extends StatefulWidget {
  const ProofScreen({super.key, this.initialOrderId});

  /// Open Proof of Delivery for [delivery]. Navigation identity is the
  /// Firestore DOCUMENT id — never the visible order number or a list position.
  ProofScreen.forDelivery(Delivery delivery, {Key? key})
      : this(key: key, initialOrderId: delivery.id);

  /// A Firestore document id.
  final String? initialOrderId;

  @override
  State<ProofScreen> createState() => _ProofScreenState();
}

class _ProofScreenState extends State<ProofScreen> {
  final _deliveryService = DeliveryService();
  final _imageService = ImageUploadService();
  final _recipientController = TextEditingController();

  late final ProofSubmissionController _submission;

  String? _riderId;
  String? _selectedOrderId;
  File? _proofPhoto;
  File? _invoicePhoto;

  /// The order the earlier-upload recovery has already run for, so it runs
  /// once per selection and only once the order's recorded state is known.
  String? _recoveryCheckedFor;

  /// Inline recipient error, shown only after a submit attempt so the field
  /// does not start out marked red.
  String? _recipientError;

  @override
  void initState() {
    super.initState();
    _riderId = FirebaseAuth.instance.currentUser?.uid;
    _selectedOrderId = widget.initialOrderId;
    _submission = ProofSubmissionController(
      uploader: _imageService,
      writer: ProofService(),
      completer: _deliveryService,
      // Re-read the order before anything uploads: a stale screen must never
      // add evidence to, or complete, an order that has since closed.
      loader: _deliveryService,
      // Server preflight: inside the clinic delivery area? Runs before any upload.
      geofence: _deliveryService,
    );
    _submission.addListener(_onSubmissionChanged);
  }

  @override
  void dispose() {
    _submission.removeListener(_onSubmissionChanged);
    _submission.dispose();
    _recipientController.dispose();
    super.dispose();
  }

  void _onSubmissionChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _pickProofPhoto() async {
    final picked = await _imageService.pickFromCamera();
    if (picked == null) return;
    // A newly chosen photo replaces any recovered upload, so "Retake" really
    // starts over instead of silently re-saving the previous object.
    _submission.clearPendingUpload();
    if (mounted) setState(() => _proofPhoto = File(picked.path));
  }

  Future<void> _pickInvoicePhoto() async {
    final picked = await _imageService.pickFromGallery();
    if (picked == null) return;
    _submission.clearPendingInvoiceUpload();
    if (mounted) setState(() => _invoicePhoto = File(picked.path));
  }

  void _onOrderSelected(String? orderId) {
    setState(() {
      _selectedOrderId = orderId;
      _proofPhoto = null;
      _invoicePhoto = null;
      _recipientError = null;
      _recoveryCheckedFor = null;
    });
    _recipientController.clear();
    _submission.resetForNewOrder();
  }

  /// Reuse uploads from an earlier attempt — but only for evidence the order
  /// has NOT recorded yet. Runs after the frame, once per selected order.
  void _scheduleRecovery(Delivery order) {
    if (_recoveryCheckedFor == order.id) return;
    _recoveryCheckedFor = order.id;
    if (!order.canComplete) return;
    final needsProof = !order.isProofFinalized;
    final needsInvoice = !order.isInvoiceFinalized;
    if (!needsProof && !needsInvoice) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _selectedOrderId != order.id) return;
      _submission.recoverPendingUpload(order.id, includeInvoice: needsInvoice);
    });
  }

  /// Proof is still to be recorded (and can be: not finalized in an older form).
  bool _needsProof(Delivery d) => !d.hasRecordedProof && !d.isProofFinalized;
  bool _needsInvoice(Delivery d) =>
      !d.hasRecordedInvoice && !d.isInvoiceFinalized;

  /// Evidence was finalized in a form the server will not accept (e.g. the
  /// removed manual-link fallback). It is one-shot, so the app cannot replace
  /// it — staff must review instead of the rider being sent round in circles.
  bool _blockedByLegacyEvidence(Delivery d) =>
      (d.isProofFinalized && !d.hasRecordedProof) ||
      (d.isInvoiceFinalized && !d.hasRecordedInvoice);

  ImageProvider? _proofPreview(Delivery d) {
    if (_proofPhoto != null) return FileImage(_proofPhoto!);
    final url = _submission.pendingProofUrl ??
        (d.hasRecordedProof ? d.proofOfDeliveryUrl : null);
    return url == null ? null : NetworkImage(url);
  }

  ImageProvider? _invoicePreview(Delivery d) {
    if (_invoicePhoto != null) return FileImage(_invoicePhoto!);
    final url = _submission.pendingInvoiceUrl ??
        (d.hasRecordedInvoice ? d.invoiceUrl : null);
    return url == null ? null : NetworkImage(url);
  }

  /// The single action. Validates, then shows the confirmation; nothing is
  /// uploaded, recorded or completed until the rider confirms.
  Future<void> _submitAndComplete(Delivery order) async {
    final needsProof = _needsProof(order) && !_submission.isProofSaved;
    if (needsProof) {
      final recipientCheck = validateRecipientName(_recipientController.text);
      setState(() => _recipientError =
          recipientCheck.valid ? null : recipientCheck.message);
      if (!recipientCheck.valid) return;
    }
    final proofPreview = _proofPreview(order);
    final invoicePreview = _invoicePreview(order);
    if (proofPreview == null || invoicePreview == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(proofPreview == null
              ? 'Take the proof-of-delivery photo first.'
              : 'Add the invoice photo first.'),
          backgroundColor: AppColors.warning,
        ),
      );
      return;
    }

    final completed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      isDismissible: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) => CompleteDeliveryConfirmSheet(
        orderNumber: order.orderNumber,
        destinationTitle: order.clinicName,
        destinationSubtitle: order.clinicAddress,
        proofImage: proofPreview,
        invoiceImage: invoicePreview,
        title: 'Submit proof & complete this delivery?',
        confirmLabel: 'Submit & Complete',
        progress: _submission,
        progressText: () => _submission.progressText,
        onConfirm: () => _runSubmitAndComplete(order),
      ),
    );

    if (completed != true || !mounted) return;
    setState(() {
      _proofPhoto = null;
      _invoicePhoto = null;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(ProofSubmissionController.completedMessage),
        backgroundColor: AppColors.primary,
      ),
    );
    // Opened for one delivery from Delivery Detail: hand back so it can close
    // too. As a tab, the live list moves the order to Completed by itself.
    if (widget.initialOrderId != null) Navigator.of(context).pop(true);
  }

  /// Runs inside the confirmation sheet. Throws (keeping the sheet open with
  /// the message) unless the server completed the delivery.
  Future<void> _runSubmitAndComplete(Delivery order) async {
    final ok = await _submission.submitAndComplete(
      orderId: order.id,
      currentStatus: order.status,
      proofRecorded: order.hasRecordedProof,
      invoiceRecorded: order.hasRecordedInvoice,
      recipientName: _recipientController.text,
      proofPhoto: _proofPhoto,
      invoicePhoto: _invoicePhoto,
      riderUid: _riderId,
    );
    if (ok) return;
    final detail = _submission.completionFailureDetail;
    final message = _submission.errorMessage ??
        'Could not complete the delivery. Please try again.';
    throw ProofException(
      'not-completed',
      detail == null ? message : '$message\n$detail',
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_riderId == null) return const Center(child: Text('Not logged in.'));

    return PopScope(
      // Refuse to leave mid-commit rather than abandoning a submission between
      // an upload, its record and the completion.
      canPop: !_submission.isCommitting,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Still completing this delivery — one moment.'),
            ),
          );
        }
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('Proof of Delivery')),
        body: StreamBuilder<List<Delivery>>(
          stream: _deliveryService.riderDeliveries(_riderId!),
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const Center(child: CircularProgressIndicator());
            }

            // Only deliveries that can still take proof and be completed are
            // choices; the selection is resolved by Firestore document id.
            final selection = resolveProofSelection(
              deliveries: snapshot.data ?? const [],
              riderUid: _riderId,
              selectedId: _selectedOrderId,
            );
            final selected = selection.selected;
            if (selected != null) _scheduleRecovery(selected);

            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (!selection.hasSelection)
                  _Card(
                    title: 'Choose a delivery',
                    subtitle: 'Deliveries out for delivery that need proof',
                    child: ProofOrderSelector(
                      eligible: selection.eligible,
                      selectedId: null,
                      onSelected: _onOrderSelected,
                      enabled: !_submission.isCommitting,
                    ),
                  )
                else if (selected == null)
                  ..._notEligible(selection)
                else ...[
                  ProofOrderSummary(
                    delivery: selected,
                    onChange: _submission.isCommitting
                        ? null
                        : () => _onOrderSelected(null),
                  ),
                  const SizedBox(height: 12),
                  if (_submission.isAlreadyCompleted)
                    const _Notice(
                      key: ValueKey('proof-already-completed'),
                      icon: Icons.check_circle_outline,
                      text: ProofSubmissionController.alreadyCompletedMessage,
                      tone: AppColors.primary,
                      background: AppColors.primaryLight,
                    )
                  else if (_blockedByLegacyEvidence(selected))
                    const _Notice(
                      icon: Icons.info_outline,
                      text: 'This delivery\'s evidence was recorded in an older '
                          'format that cannot be completed from the app. Contact '
                          'your dispatcher.',
                      tone: AppColors.warning,
                      background: AppColors.warningBg,
                    )
                  else
                    ..._activeEvidence(selected),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  /// An active delivery: whatever evidence is still needed, then the action.
  List<Widget> _activeEvidence(Delivery order) {
    final needsProof = _needsProof(order) && !_submission.isProofSaved;
    final needsInvoice = _needsInvoice(order) && !_submission.isInvoiceSaved;
    final evidenceRecorded = !needsProof && !needsInvoice;
    final pending = _submission.isCompletionPending ||
        (evidenceRecorded && !_submission.isCommitting);

    return [
      if (needsProof) ...[
        _recipientCard(),
        const SizedBox(height: 12),
        _proofPhotoCard(),
        const SizedBox(height: 12),
      ] else if (order.hasRecordedProof) ...[
        _recordedThumbCard('Proof photo', order.proofOfDeliveryUrl!,
            subtitle: (order.proofRecipientName ?? '').isEmpty
                ? 'Recorded'
                : 'Received by ${order.proofRecipientName}'),
        const SizedBox(height: 12),
      ],
      if (needsInvoice) ...[
        _invoiceCard(),
        const SizedBox(height: 12),
      ] else if (order.hasRecordedInvoice) ...[
        _recordedThumbCard('Invoice photo', order.invoiceUrl!,
            subtitle: 'Recorded'),
        const SizedBox(height: 12),
      ],
      const SizedBox(height: 4),
      // Recorded evidence with no completion yet — from this session or an
      // earlier one — is the "completion still pending" state.
      if (pending && _submission.errorMessage == null) ...[
        const _Notice(
          icon: Icons.cloud_done_outlined,
          text: ProofSubmissionController.completionPendingMessage,
          tone: AppColors.warning,
          background: AppColors.warningBg,
        ),
        const SizedBox(height: 12),
      ],
      _statusMessages(),
      _submitAndCompleteButton(order, retryOnly: pending),
    ];
  }

  /// The requested delivery cannot take proof (any more). Say why; never fall
  /// back to another order. Completed in THIS session reads as success.
  List<Widget> _notEligible(ProofSelection selection) {
    final reason = selection.blockedReason!;
    final completedHere = reason == ProofIneligibility.completed &&
        (_submission.isCompleted || _submission.isAlreadyCompleted);
    return [
      _Notice(
        key: const ValueKey('proof-not-eligible'),
        icon: reason == ProofIneligibility.completed
            ? Icons.check_circle
            : Icons.info_outline,
        text: completedHere
            ? ProofSubmissionController.completedMessage
            : proofIneligibilityMessage(reason),
        tone: reason == ProofIneligibility.completed
            ? AppColors.primary
            : AppColors.warning,
        background: reason == ProofIneligibility.completed
            ? AppColors.primaryLight
            : AppColors.warningBg,
      ),
      const SizedBox(height: 12),
      if (selection.eligible.isNotEmpty && !_submission.isCommitting)
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: () => _onOrderSelected(null),
            icon: const Icon(Icons.list_alt, size: 18),
            label: const Text('Choose another delivery'),
          ),
        ),
    ];
  }

  /// Evidence already recorded on the order, shown small and read-only.
  Widget _recordedThumbCard(String title, String url, {String? subtitle}) {
    return _Card(
      title: title,
      subtitle: subtitle,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Image.network(
          url,
          height: 120,
          width: double.infinity,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => const _Notice(
            icon: Icons.image_not_supported_outlined,
            text: 'The image could not be loaded.',
          ),
        ),
      ),
    );
  }

  Widget _recipientCard() {
    return _Card(
      title: 'Received by',
      subtitle: 'Who accepted this delivery',
      child: TextField(
        controller: _recipientController,
        enabled: !_submission.isCommitting,
        textCapitalization: TextCapitalization.words,
        maxLength: kMaxRecipientNameLength,
        onChanged: (_) {
          setState(() => _recipientError = null);
        },
        decoration: InputDecoration(
          // A visible label, not a placeholder that vanishes on focus.
          labelText: "Recipient's full name",
          helperText: 'Required. As given by the person receiving the vaccines.',
          errorText: _recipientError,
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        ),
      ),
    );
  }

  Widget _proofPhotoCard() {
    final hasRecovered = _submission.hasPendingUpload && _proofPhoto == null;
    return _Card(
      title: 'Proof Photo',
      subtitle: 'Required — take a photo as delivery confirmation',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_proofPhoto == null && !hasRecovered)
            GestureDetector(
              onTap: _submission.isCommitting ? null : _pickProofPhoto,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 28),
                decoration: BoxDecoration(
                  border: Border.all(
                    color: AppColors.borderLight,
                    width: 2,
                    strokeAlign: BorderSide.strokeAlignCenter,
                  ),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Column(
                  children: [
                    Icon(Icons.camera_alt, size: 28, color: AppColors.primary),
                    SizedBox(height: 8),
                    Text('Tap to take photo',
                        style: TextStyle(
                            fontSize: 13, fontWeight: FontWeight.w600)),
                    Text('JPG, PNG up to 10MB',
                        style:
                            TextStyle(fontSize: 11, color: AppColors.textMuted)),
                  ],
                ),
              ),
            )
          else ...[
            if (_proofPhoto != null)
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.file(
                  _proofPhoto!,
                  height: 180,
                  width: double.infinity,
                  fit: BoxFit.cover,
                ),
              )
            else
              const _Notice(
                icon: Icons.cloud_done_outlined,
                text: 'A photo from an earlier attempt is uploaded and will be '
                    'reused.',
              ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _submission.isCommitting ? null : _pickProofPhoto,
                icon: const Icon(Icons.refresh, size: 18),
                label: Text(_proofPhoto == null
                    ? 'Take a different photo'
                    : 'Retake photo'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _invoiceCard() {
    final hasRecovered =
        _submission.hasPendingInvoiceUpload && _invoicePhoto == null;
    return _Card(
      title: 'Invoice / Receipt',
      subtitle: 'Required to complete the delivery',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_invoicePhoto == null && !hasRecovered)
            GestureDetector(
              onTap: _submission.isCommitting ? null : _pickInvoicePhoto,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 20),
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.border),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Column(
                  children: [
                    Icon(Icons.receipt_long,
                        size: 24, color: AppColors.textLight),
                    SizedBox(height: 6),
                    Text('Upload invoice photo',
                        style: TextStyle(
                            fontSize: 12, color: AppColors.textLight)),
                  ],
                ),
              ),
            )
          else ...[
            if (_invoicePhoto != null)
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.file(
                  _invoicePhoto!,
                  height: 120,
                  width: double.infinity,
                  fit: BoxFit.cover,
                ),
              )
            else
              const _Notice(
                icon: Icons.cloud_done_outlined,
                text: 'An invoice photo from an earlier attempt is uploaded '
                    'and will be reused.',
              ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _submission.isCommitting ? null : _pickInvoicePhoto,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Choose another photo'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _statusMessages() {
    final progress = _submission.progressText;
    final error = _submission.errorMessage;
    final detail = _submission.completionFailureDetail;
    final notice = _submission.isCompleted ? null : _submission.noticeMessage;

    return Column(
      children: [
        if (progress != null) ...[
          Row(
            children: [
              const SizedBox(
                height: 16,
                width: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(progress,
                    style: const TextStyle(
                        fontSize: 13, color: AppColors.textMedium)),
              ),
            ],
          ),
          const SizedBox(height: 12),
        ],
        if (error != null) ...[
          _Notice(
            icon: Icons.error_outline,
            text: detail == null ? error : '$error\n$detail',
            tone: AppColors.urgent,
            background: AppColors.urgentBg,
          ),
          const SizedBox(height: 12),
        ],
        if (notice != null) ...[
          _Notice(
            icon: Icons.info_outline,
            text: notice,
            tone: AppColors.warning,
            background: AppColors.warningBg,
          ),
          const SizedBox(height: 12),
        ],
      ],
    );
  }

  Widget _submitAndCompleteButton(Delivery order, {required bool retryOnly}) {
    final ready = _submission.canSubmitAndComplete(
      recipientName: _recipientController.text,
      hasProofPhoto: _proofPhoto != null,
      hasInvoicePhoto: _invoicePhoto != null,
      proofRecorded: order.hasRecordedProof,
      invoiceRecorded: order.hasRecordedInvoice,
    );

    return SizedBox(
      width: double.infinity,
      child: ElevatedButton.icon(
        key: const ValueKey('submit-and-complete'),
        onPressed: ready ? () => _submitAndComplete(order) : null,
        icon: _submission.isCommitting
            ? const SizedBox(
                height: 18,
                width: 18,
                child: CircularProgressIndicator(
                    color: Colors.white, strokeWidth: 2),
              )
            : Icon(retryOnly ? Icons.refresh : Icons.check_circle),
        label: Text(retryOnly
            ? 'Retry Completion'
            : 'Submit Proof & Complete Delivery'),
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.title, this.subtitle, required this.child});

  final String title;
  final String? subtitle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title,
                style:
                    const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            if (subtitle != null) ...[
              const SizedBox(height: 4),
              Text(subtitle!,
                  style: const TextStyle(
                      fontSize: 12, color: AppColors.textLight)),
            ],
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    super.key,
    required this.icon,
    required this.text,
    this.tone = AppColors.textLight,
    this.background = AppColors.background,
  });

  final IconData icon;
  final String text;
  final Color tone;
  final Color background;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: tone),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 12, color: tone)),
          ),
        ],
      ),
    );
  }
}
