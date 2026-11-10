import 'package:flutter/material.dart';

import '../offline/offline_delivery_queue.dart';
import '../offline/offline_delivery_record.dart';
import '../theme/app_theme.dart';
import 'motion.dart';

/// Deliveries recorded on the phone without signal, and what became of them.
/// Hidden when there are none. "Send now" retries at once; sent records can
/// be dismissed once read.
class OfflineDeliveriesBanner extends StatelessWidget {
  const OfflineDeliveriesBanner({super.key, required this.queue});

  final OfflineDeliveryQueue queue;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: queue,
      builder: (context, _) {
        final records = queue.records;
        final waiting = records.where((r) => r.isWaiting).length;
        // Opens when something is saved on the phone, and turns from amber
        // "waiting" to green "sent" in place once signal returns.
        return FeedbackReveal(
          identity: waiting > 0 ? 'waiting' : 'sent',
          child: records.isEmpty ? null : _banner(records, waiting),
        );
      },
    );
  }

  Widget _banner(List<OfflineDeliveryRecord> records, int waiting) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: waiting > 0 ? AppColors.warningBg : AppColors.primaryLight,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                waiting > 0
                    ? Icons.cloud_upload_outlined
                    : Icons.cloud_done_outlined,
                size: 18,
                color: waiting > 0 ? AppColors.warning : AppColors.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  waiting > 0
                      ? '$waiting saved on your phone — waiting for signal'
                      : 'Sent from your phone',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              if (waiting > 0)
                TextButton(
                  onPressed: queue.isSyncing ? null : queue.sync,
                  child: Text(queue.isSyncing ? 'Sending…' : 'Send now'),
                ),
            ],
          ),
          for (final r in records)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      '${r.orderNumber.isEmpty ? 'Delivery' : r.orderNumber} · ${r.destinationName}\n'
                      '${offlineRecordStatusText(r)}',
                      style: TextStyle(
                        fontSize: 12,
                        color: r.stage == OfflineRecordStage.refused
                            ? AppColors.urgent
                            : AppColors.textMedium,
                      ),
                    ),
                  ),
                  if (!r.isWaiting)
                    IconButton(
                      tooltip: 'Dismiss',
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.close, size: 16),
                      onPressed: () => queue.dismiss(r.orderId),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
