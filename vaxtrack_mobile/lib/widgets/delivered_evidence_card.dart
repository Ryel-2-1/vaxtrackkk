import 'package:flutter/material.dart';

import '../models/delivery.dart';
import '../theme/app_theme.dart';

/// A delivered order's recorded evidence, READ-ONLY.
///
/// Delivered orders are no longer offered on the Proof of Delivery screen —
/// proof is gathered while delivering, and a completed delivery is not a prompt
/// to add more. Their photos stay viewable here, on the order's own details.
class DeliveredEvidenceCard extends StatelessWidget {
  const DeliveredEvidenceCard({super.key, required this.delivery});

  final Delivery delivery;

  @override
  Widget build(BuildContext context) {
    final d = delivery;
    return Card(
      key: const ValueKey('delivered-evidence'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Proof of delivery',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            const Text('Recorded. Contact your dispatcher if this needs to be changed.',
                style: TextStyle(fontSize: 12, color: AppColors.textLight)),
            const SizedBox(height: 12),
            if (!d.hasProof)
              const Text(
                'Proof unavailable. This delivery was completed without a proof '
                'photo — staff review is required. It cannot be added now.',
                style: TextStyle(fontSize: 12, color: AppColors.textMedium),
              )
            else ...[
              _photo(d.proofOfDeliveryUrl!, 'The proof image could not be loaded.'),
              if ((d.proofRecipientName ?? '').isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('Received by ${d.proofRecipientName}',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              ],
            ],
            if (d.hasInvoice) ...[
              const SizedBox(height: 12),
              const Text('Invoice photo',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textMedium)),
              const SizedBox(height: 6),
              _photo(d.invoiceUrl!, 'The invoice image could not be loaded.'),
            ],
          ],
        ),
      ),
    );
  }

  Widget _photo(String url, String errorText) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Image.network(
        url,
        height: 160,
        width: double.infinity,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => Container(
          height: 60,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.all(12),
          color: AppColors.background,
          child: Text(errorText, style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
        ),
      ),
    );
  }
}
