import 'dart:io';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/image_upload_service.dart';
import '../theme/app_theme.dart';

class ProofScreen extends StatefulWidget {
  const ProofScreen({super.key});

  @override
  State<ProofScreen> createState() => _ProofScreenState();
}

class _ProofScreenState extends State<ProofScreen> {
  final _deliveryService = DeliveryService();
  final _imageService = ImageUploadService();
  String? _riderId;

  String? _selectedOrderId;
  File? _proofPhoto;
  File? _invoicePhoto;
  bool _uploading = false;
  bool _submitted = false;

  // Temporary no-Blaze fallback: paste an existing HTTPS image URL instead of
  // uploading through Firebase Storage (which is not provisioned on this
  // project yet). The camera upload path above is left fully intact for when
  // Storage is enabled.
  bool _useManualUrl = false;
  final _manualUrlController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _riderId = FirebaseAuth.instance.currentUser?.uid;
  }

  @override
  void dispose() {
    _manualUrlController.dispose();
    super.dispose();
  }

  Future<void> _pickProofPhoto() async {
    final picked = await _imageService.pickFromCamera();
    if (picked != null) {
      setState(() => _proofPhoto = File(picked.path));
    }
  }

  Future<void> _pickInvoicePhoto() async {
    final picked = await _imageService.pickFromGallery();
    if (picked != null) {
      setState(() => _invoicePhoto = File(picked.path));
    }
  }

  Future<void> _submit() async {
    if (_selectedOrderId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a delivery first.')),
      );
      return;
    }

    final manualUrl = _manualUrlController.text.trim();

    if (_useManualUrl) {
      if (manualUrl.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Enter a proof image URL, or turn off the URL option.')),
        );
        return;
      }
      if (!manualUrl.startsWith('https://')) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Proof image URL must start with https://')),
        );
        return;
      }
    } else if (_proofPhoto == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Select a delivery and take a proof photo.')),
      );
      return;
    }

    setState(() => _uploading = true);

    try {
      if (_useManualUrl) {
        // No-Blaze fallback: write the pasted URL straight to the order,
        // skipping Firebase Storage entirely. Invoice upload is skipped in
        // this mode since it also depends on Storage.
        await _deliveryService.saveProofOfDelivery(_selectedOrderId!, manualUrl);
      } else {
        final proofUrl = await _imageService.uploadProofOfDelivery(_selectedOrderId!, _proofPhoto!);
        await _deliveryService.saveProofOfDelivery(_selectedOrderId!, proofUrl);

        if (_invoicePhoto != null) {
          final invoiceUrl = await _imageService.uploadInvoice(_selectedOrderId!, _invoicePhoto!);
          await _deliveryService.saveInvoicePhoto(_selectedOrderId!, invoiceUrl);
        }
      }

      setState(() {
        _submitted = true;
        _proofPhoto = null;
        _invoicePhoto = null;
        _manualUrlController.clear();
      });

      Future.delayed(const Duration(seconds: 3), () {
        if (mounted) setState(() => _submitted = false);
      });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Upload failed: $e'), backgroundColor: AppColors.urgent),
        );
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_riderId == null) return const Center(child: Text('Not logged in.'));

    return Scaffold(
      appBar: AppBar(title: const Text('Proof of Delivery')),
      body: StreamBuilder<List<Delivery>>(
        stream: _deliveryService.riderDeliveries(_riderId!),
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          final deliveries = snapshot.data ?? [];
          final eligible = deliveries.where((d) =>
              d.isInTransit || d.isDelivered).toList();

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Select Delivery',
                          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 4),
                      const Text('Choose a delivery to upload proof for',
                          style: TextStyle(fontSize: 12, color: AppColors.textLight)),
                      const SizedBox(height: 12),
                      if (eligible.isEmpty)
                        const Text('No deliveries available for proof upload.',
                            style: TextStyle(color: AppColors.textMuted, fontSize: 13))
                      else
                        DropdownButtonFormField<String>(
                          initialValue: _selectedOrderId,
                          decoration: const InputDecoration(
                            labelText: 'Delivery Order',
                            contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                          ),
                          items: eligible.map((d) {
                            return DropdownMenuItem(
                              value: d.id,
                              child: Text('${d.orderNumber} — ${d.clinicName}', overflow: TextOverflow.ellipsis),
                            );
                          }).toList(),
                          onChanged: (v) => setState(() => _selectedOrderId = v),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Proof Photo',
                          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 4),
                      const Text('Take a photo as delivery confirmation',
                          style: TextStyle(fontSize: 12, color: AppColors.textLight)),
                      const SizedBox(height: 12),
                      GestureDetector(
                        onTap: _pickProofPhoto,
                        child: Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(vertical: 28),
                          decoration: BoxDecoration(
                            border: Border.all(color: AppColors.borderLight, width: 2, strokeAlign: BorderSide.strokeAlignCenter),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Column(
                            children: [
                              Icon(Icons.camera_alt, size: 28, color: AppColors.primary),
                              const SizedBox(height: 8),
                              const Text('Tap to take photo',
                                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                              const Text('JPG, PNG up to 10MB',
                                  style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
                            ],
                          ),
                        ),
                      ),
                      if (_proofPhoto != null) ...[
                        const SizedBox(height: 12),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(_proofPhoto!, height: 160, width: double.infinity, fit: BoxFit.cover),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: const [
                                Text('Use proof image URL instead',
                                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                                SizedBox(height: 2),
                                Text('Temporary demo fallback (Firebase Storage not enabled)',
                                    style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
                              ],
                            ),
                          ),
                          Switch(
                            value: _useManualUrl,
                            onChanged: (v) => setState(() => _useManualUrl = v),
                          ),
                        ],
                      ),
                      if (_useManualUrl) ...[
                        const SizedBox(height: 8),
                        TextField(
                          controller: _manualUrlController,
                          keyboardType: TextInputType.url,
                          decoration: const InputDecoration(
                            labelText: 'Proof image URL',
                            hintText: 'https://...',
                            contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                          ),
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Must be a public HTTPS image link. Skips Firebase Storage upload and saves the link directly to the order.',
                          style: TextStyle(fontSize: 11, color: AppColors.textLight),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Invoice / Receipt (Optional)',
                          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 12),
                      GestureDetector(
                        onTap: _pickInvoicePhoto,
                        child: Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(vertical: 20),
                          decoration: BoxDecoration(
                            border: Border.all(color: AppColors.border),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Column(
                            children: [
                              Icon(Icons.receipt_long, size: 24, color: AppColors.textLight),
                              const SizedBox(height: 6),
                              const Text('Upload invoice photo',
                                  style: TextStyle(fontSize: 12, color: AppColors.textLight)),
                            ],
                          ),
                        ),
                      ),
                      if (_invoicePhoto != null) ...[
                        const SizedBox(height: 12),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(_invoicePhoto!, height: 120, width: double.infinity, fit: BoxFit.cover),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (_submitted)
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.primaryBg,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.check_circle, color: AppColors.primary, size: 18),
                      SizedBox(width: 8),
                      Text('Proof submitted successfully!',
                          style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w600)),
                    ],
                  ),
                )
              else
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _uploading ? null : _submit,
                    child: _uploading
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                          )
                        : const Text('Submit Proof of Delivery'),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
