import 'package:flutter/material.dart';

import '../models/delivery.dart';
import '../theme/app_theme.dart';
import 'order_number_text.dart';

/// One delivery in the Deliveries screen's Active, Completed and All tabs.
///
/// This used to be a ListTile with the status chip as `trailing`, which left
/// the order number a narrow column between the 44dp icon and the chip; long
/// numbers wrapped across three lines. The chip now sits on its own line
/// under the details, so the number gets the full content width and the card
/// simply grows taller when clinic or vaccine names wrap.
class DeliveryListCard extends StatelessWidget {
  const DeliveryListCard({super.key, required this.delivery, this.onTap});

  final Delivery delivery;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final d = delivery;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: d.isDelivered
                      ? AppColors.primaryLight
                      : (d.isUrgent ? AppColors.urgentBg : AppColors.infoBg),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                  d.isDelivered
                      ? Icons.check_circle
                      : (d.isInTransit ? Icons.local_shipping : Icons.inventory_2),
                  color: d.isDelivered
                      ? AppColors.primary
                      : (d.isUrgent ? AppColors.urgent : AppColors.info),
                  size: 22,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    OrderNumberText(
                      d.orderNumber,
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                    ),
                    const SizedBox(height: 2),
                    Text(d.clinicName, style: const TextStyle(fontSize: 13)),
                    const SizedBox(height: 2),
                    Text('${d.vaccineName} · ${d.quantity} ${d.unit}',
                        style: const TextStyle(fontSize: 11, color: AppColors.textLight)),
                    const SizedBox(height: 8),
                    _statusChip(d),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _statusChip(Delivery d) {
    Color bg;
    Color fg;
    switch (d.status) {
      case 'in_transit':
        bg = AppColors.infoBg;
        fg = AppColors.info;
        break;
      case 'delivered':
      case 'completed':
        bg = AppColors.primaryLight;
        fg = AppColors.primary;
        break;
      case 'delayed':
        bg = AppColors.urgentBg;
        fg = AppColors.urgent;
        break;
      default:
        bg = AppColors.warningBg;
        fg = AppColors.warning;
    }
    return Container(
      key: const ValueKey('delivery-status-chip'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Text(d.statusLabel,
          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: fg)),
    );
  }
}
