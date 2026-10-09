import 'package:flutter/material.dart';

import '../models/delivery.dart';
import '../theme/app_theme.dart';
import 'order_number_text.dart';

/// One delivery on the Rider Dashboard.
///
/// The header used to be a single Row: the order number (Flexible, ellipsized)
/// beside the priority and status badges. On a narrow phone the badges won and
/// the number was cut to "VT-ORD-1791…". The number now has its own full-width
/// line, and the badges sit in a Wrap beneath it, so neither is clipped and a
/// long label moves to the next run instead of overflowing.
class DashboardDeliveryCard extends StatelessWidget {
  const DashboardDeliveryCard({super.key, required this.delivery, this.onTap});

  final Delivery delivery;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final d = delivery;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              OrderNumberText(
                d.orderNumber,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 6),
              Wrap(
                key: const ValueKey('delivery-badges'),
                spacing: 6,
                runSpacing: 4,
                children: [
                  _badge(d.priority, d.priority == 'Urgent' ? AppColors.urgentBg : AppColors.primaryLight,
                      d.priority == 'Urgent' ? AppColors.urgent : AppColors.primary),
                  _statusBadge(d),
                ],
              ),
              const SizedBox(height: 6),
              Text(d.clinicName, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
              if (d.isOnTrip) ...[
                const SizedBox(height: 6),
                _tripStopChip(d),
              ],
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.location_on, size: 14, color: AppColors.textLight),
                  const SizedBox(width: 4),
                  Expanded(child: Text(d.clinicAddress, style: const TextStyle(fontSize: 12, color: AppColors.textLight))),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.vaccines, size: 14, color: AppColors.textLight),
                  const SizedBox(width: 4),
                  // The vaccine name is variable-length: Expanded (not
                  // ellipsis) so the full name stays readable by wrapping,
                  // matching the address row above.
                  Expanded(
                    child: Text('${d.vaccineName} — ${d.quantity} ${d.unit}',
                        style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
                  ),
                ],
              ),
              if (d.isDelivered) ...[
                const SizedBox(height: 10),
                const Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.check_circle, color: AppColors.primary, size: 16),
                    SizedBox(width: 6),
                    Text('Delivered', style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700)),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _tripStopChip(Delivery d) {
    final total = d.tripStopCount;
    final label = (total != null && total > 0)
        ? 'Stop ${d.stopSequence} of $total'
        : 'Stop ${d.stopSequence}';
    final eta =
        (d.stopEtaText ?? '').isNotEmpty ? ' · ETA ${d.stopEtaText}' : '';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: AppColors.infoBg,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.alt_route, size: 13, color: AppColors.info),
          const SizedBox(width: 4),
          // Flexible so a long ETA wraps inside the chip instead of
          // overflowing it on a narrow phone.
          Flexible(
            child: Text(
              '$label$eta',
              style: const TextStyle(
                  fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.info),
            ),
          ),
        ],
      ),
    );
  }

  Widget _badge(String text, Color bg, Color fg) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
      child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: fg)),
    );
  }

  Widget _statusBadge(Delivery d) {
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
    return _badge(d.statusLabel, bg, fg);
  }
}
