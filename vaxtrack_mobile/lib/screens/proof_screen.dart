import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';

import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/image_upload_service.dart';
import '../services/proof_service.dart';
import '../theme/app_theme.dart';
import '../utils/proof_validation.dart';
import 'proof_submission_controller.dart';

class ProofScreen extends StatefulWidget {
  const ProofScreen({super.key});

  @override
  State<ProofScreen> createState() => _ProofScreenState();
}

class _ProofScreenState extends State<ProofScreen> {
  final _deliveryService = DeliveryService();
  final _imageService = ImageUploadService();
  final _recipientController = TextEditingController();
  final _manualUrlController = TextEditingController();

  late final ProofSubmissionController _submission;

  String? _riderId;
  String? _selectedOrderId;
  File? _proofPhoto;
  File? _invoicePhoto;

  /// Inline recipient error, shown only after a submit attempt so the field
  /// does not start out marked red.
  String? _recipientError;

  /// The temporary manual-link fallback. Debug builds only — see
  /// [manualProofUrlEnabled].
  bool _useManualUrl = false;

  @override
  void initState() {
    super.initState();
    _riderId = FirebaseAuth.instance.currentUser?.uid;
    _submission = ProofSubmissionController(
      uploader: _imageService,
      writer: ProofService(),
      allowManualUrl: manualProofUrlEnabled(isDebugBuild: kDebugMode),
    );
    _submission.addListener(_onSubmissionChanged);
  }

  @override
  void dispose() {
    _submission.removeListener(_onSubmissionChanged);
    _submission.dispose();
    _recipientController.dispose();
    _manualUrlController.dispose();
    super.dispose();
  }

  void _onSubmissionChanged() {
    if (mounted) setState(() {});
  }

  bool get _manualUrlAvailable =>
      manualProofUrlEnabled(isDebugBuild: kDebugMode);

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
    if (mounted) setState(() => _invoicePhoto = File(picked.path));
  }

  Future<void> _onOrderSelected(String? orderId, List<Delivery> eligible) async {
    setState(() {
      _selectedOrderId = orderId;
      _proofPhoto = null;
      _invoicePhoto = null;
      _recipientError = null;
    });
    _submission.clearPendingUpload();
    if (orderId == null) return;

    final order = _findOrder(eligible, orderId);
    // Only worth checking when the order could still accept proof: a completed
    // or already-proven order has nothing pending to recover.
    if (order != null && order.canSubmitProof && !order.hasProof) {
      await _submission.recoverPendingUpload(orderId);
    }
  }

  Delivery? _findOrder(List<Delivery> deliveries, String id) {
    for (final d in deliveries) {
      if (d.id == id) return d;
    }
    return null;
  }

  Future<void> _submit(Delivery order) async {
    final recipientCheck = validateRecipientName(_recipientController.text);
    setState(() =>
        _recipientError = recipientCheck.valid ? null : recipientCheck.message);
    if (!recipientCheck.valid) return;

    await _submission.submit(
      orderId: order.id,
      recipientName: _recipientController.text,
      proofPhoto: _proofPhoto,
      invoicePhoto: _invoicePhoto,
      manualUrl: _useManualUrl ? _manualUrlController.text : null,
    );

    if (!mounted) return;
    if (_submission.phase == ProofPhase.submitted) {
      // The photo is cleared only once it is safely referenced by the order.
      // The recipient name stays: Firestore's snapshot is the source of truth
      // for what was recorded, and the screen does not invent a local
      // "completed" state — the order's own proof section takes over.
      setState(() {
        _proofPhoto = null;
        _invoicePhoto = null;
        _manualUrlController.clear();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_riderId == null) return const Center(child: Text('Not logged in.'));

    return PopScope(
      // Refuse to leave mid-commit rather than abandoning a submission between
      // the upload and the save.
      canPop: !_submission.isCommitting,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Still saving your proof — one moment.'),
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

            final deliveries = snapshot.data ?? [];
            // In transit or delayed — the two statuses proof may be attached in
            // — plus delivered orders, which appear READ-ONLY so a rider can
            // confirm what was recorded without being invited to add more.
            final eligible = deliveries
                .where((d) => d.canSubmitProof || d.isDelivered || d.hasProof)
                .toList();
            final selected = _selectedOrderId == null
                ? null
                : _findOrder(eligible, _selectedOrderId!);

            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _selectDeliveryCard(eligible),
                const SizedBox(height: 12),
                if (selected == null)
                  const _InfoCard(
                    text: 'Choose a delivery above to record its proof.',
                  )
                else if (!selected.canSubmitProof) ...[
                  _readOnlyProofCard(selected),
                  // The proof landed but its optional invoice photo did not.
                  // The order is finalized for proof, so the form above is
                  // gone — but the notice tells the rider to retry, and that
                  // has to be actionable.
                  if (_submission.hasOutstandingInvoice) ...[
                    const SizedBox(height: 12),
                    _invoiceCard(),
                    const SizedBox(height: 16),
                    _statusMessages(),
                    _submitButton(selected),
                  ],
                ] else ...[
                  _recipientCard(),
                  const SizedBox(height: 12),
                  _proofPhotoCard(),
                  const SizedBox(height: 12),
                  _invoiceCard(),
                  if (_manualUrlAvailable) ...[
                    const SizedBox(height: 12),
                    _manualUrlCard(),
                  ],
                  const SizedBox(height: 16),
                  _statusMessages(),
                  _submitButton(selected),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _selectDeliveryCard(List<Delivery> eligible) {
    return _Card(
      title: 'Select Delivery',
      subtitle: 'Choose a delivery to record proof for',
      child: eligible.isEmpty
          ? const Text(
              'No deliveries available for proof upload.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
            )
          : DropdownButtonFormField<String>(
              // Fill the available width so long labels ellipsize instead of
              // overflowing the field on narrow phones.
              isExpanded: true,
              initialValue: _selectedOrderId,
              decoration: const InputDecoration(
                labelText: 'Delivery Order',
                contentPadding:
                    EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
              // Collapsed (selected) label: width-constrained + ellipsized,
              // with the full label on long-press. The underlying value stays
              // the full order id.
              selectedItemBuilder: (context) => eligible.map((d) {
                final label = '${d.orderNumber} — ${d.clinicName}';
                return Align(
                  alignment: Alignment.centerLeft,
                  child: Tooltip(
                    message: label,
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      softWrap: false,
                    ),
                  ),
                );
              }).toList(),
              items: eligible.map((d) {
                return DropdownMenuItem(
                  value: d.id,
                  child: Text(
                    '${d.orderNumber} — ${d.clinicName}'
                    '${d.canSubmitProof ? '' : ' (recorded)'}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    softWrap: false,
                  ),
                );
              }).toList(),
              onChanged: _submission.isCommitting
                  ? null
                  : (v) => _onOrderSelected(v, eligible),
            ),
    );
  }

  /// A delivery that can no longer accept proof: delivered, or already proven.
  /// Read-only by design — evidence is gathered during the delivery, and a
  /// closed delivery with no proof is a gap for staff, not a prompt to create a
  /// record after the fact.
  Widget _readOnlyProofCard(Delivery order) {
    return _Card(
      title: 'Proof of delivery',
      subtitle: order.statusLabel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (order.hasProof) ...[
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.network(
                order.proofOfDeliveryUrl!,
                height: 180,
                width: double.infinity,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const _Notice(
                  icon: Icons.image_not_supported_outlined,
                  text: 'The proof image could not be loaded.',
                ),
              ),
            ),
            const SizedBox(height: 10),
            if ((order.proofRecipientName ?? '').isNotEmpty)
              Text(
                'Received by ${order.proofRecipientName}',
                style: const TextStyle(
                    fontSize: 13, fontWeight: FontWeight.w600),
              ),
            const SizedBox(height: 4),
            const Text(
              'Recorded. Contact your dispatcher if this needs to be changed.',
              style: TextStyle(fontSize: 12, color: AppColors.textLight),
            ),
          ] else
            const _Notice(
              icon: Icons.info_outline,
              text:
                  'Proof unavailable. This delivery was completed without a '
                  'proof photo — staff review is required. It cannot be added '
                  'now.',
            ),
        ],
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
          if (_recipientError != null) setState(() => _recipientError = null);
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
      subtitle: 'Take a photo as delivery confirmation',
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
                text: 'A photo from an earlier attempt is ready to save.',
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
    return _Card(
      title: 'Invoice / Receipt (Optional)',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
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
                  Icon(Icons.receipt_long, size: 24, color: AppColors.textLight),
                  SizedBox(height: 6),
                  Text('Upload invoice photo',
                      style:
                          TextStyle(fontSize: 12, color: AppColors.textLight)),
                ],
              ),
            ),
          ),
          if (_invoicePhoto != null) ...[
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.file(
                _invoicePhoto!,
                height: 120,
                width: double.infinity,
                fit: BoxFit.cover,
              ),
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

  /// Temporary staging/development fallback. Never built in a release binary —
  /// [manualProofUrlEnabled] gates the whole card, and the controller refuses a
  /// manual link independently even if this widget were somehow reached.
  Widget _manualUrlCard() {
    return _Card(
      title: 'Developer: use a proof image link',
      subtitle: 'Debug builds only — not part of the normal delivery flow',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Skips the camera and Storage upload. Kept only until the '
                  'camera route is proven on a real phone.',
                  style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                ),
              ),
              Switch(
                value: _useManualUrl,
                onChanged: _submission.isCommitting
                    ? null
                    : (v) => setState(() => _useManualUrl = v),
              ),
            ],
          ),
          if (_useManualUrl) ...[
            const SizedBox(height: 8),
            TextField(
              controller: _manualUrlController,
              enabled: !_submission.isCommitting,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'Proof image URL',
                hintText: 'https://...',
                contentPadding:
                    EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'The recipient name and the delivery checks below still apply.',
              style: TextStyle(fontSize: 11, color: AppColors.textLight),
            ),
          ],
        ],
      ),
    );
  }

  Widget _statusMessages() {
    final progress = _submission.progressText;
    final error = _submission.errorMessage;
    final notice = _submission.noticeMessage;

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
              Text(progress,
                  style: const TextStyle(
                      fontSize: 13, color: AppColors.textMedium)),
            ],
          ),
          const SizedBox(height: 12),
        ],
        if (error != null) ...[
          _Notice(
            icon: Icons.error_outline,
            text: error,
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

  Widget _submitButton(Delivery order) {
    final ready = _submission.canSubmit(
      recipientName: _recipientController.text,
      hasPhoto: _proofPhoto != null,
      manualUrl: _useManualUrl ? _manualUrlController.text : null,
    );
    final idle = !_submission.isCommitting;

    String label;
    if (_submission.isProofSaved) {
      label = 'Retry attaching the invoice photo';
    } else if (_submission.hasPendingUpload && idle) {
      label = 'Retry saving proof details';
    } else {
      label = 'Submit Proof of Delivery';
    }

    return SizedBox(
      width: double.infinity,
      child: ElevatedButton(
        onPressed: ready ? () => _submit(order) : null,
        child: _submission.isCommitting
            ? const SizedBox(
                height: 20,
                width: 20,
                child: CircularProgressIndicator(
                    color: Colors.white, strokeWidth: 2),
              )
            : Text(label),
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

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Text(text,
            style: const TextStyle(fontSize: 13, color: AppColors.textLight)),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
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
