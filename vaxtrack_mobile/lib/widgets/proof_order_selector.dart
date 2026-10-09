import 'package:flutter/material.dart';

import '../models/delivery.dart';
import '../theme/app_theme.dart';
import '../utils/proof_eligibility.dart';
import 'order_number_text.dart';

/// The Proof screen's choice of delivery, replacing the single-line dropdown.
///
/// The dropdown truncated order numbers to "VT-ORD-1791…" and listed completed
/// deliveries too, so on a narrow phone a rider scrolled a long list of
/// near-identical stubs. This lists ONLY the eligible deliveries (see
/// proof_eligibility.dart), each as a multi-line item: the full order number,
/// the doctor and destination, and the status — and, when two eligible orders
/// share an order number, a short document reference so they stay apart.
/// Selection is by Firestore document id.
class ProofOrderSelector extends StatelessWidget {
  const ProofOrderSelector({
    super.key,
    required this.eligible,
    required this.selectedId,
    required this.onSelected,
    this.enabled = true,
  });

  final List<Delivery> eligible;
  final String? selectedId;
  final ValueChanged<String> onSelected;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    if (eligible.isEmpty) return const ProofSelectorEmptyState();
    final dupes = duplicateOrderNumbers(eligible);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final d in eligible)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: _OrderChoice(
              key: ValueKey('proof-order-${d.id}'),
              delivery: d,
              selected: d.id == selectedId,
              showRef: dupes.contains(d.orderNumber),
              onTap: enabled ? () => onSelected(d.id) : null,
            ),
          ),
      ],
    );
  }
}

/// No delivery currently needs proof.
class ProofSelectorEmptyState extends StatelessWidget {
  const ProofSelectorEmptyState({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('proof-selector-empty'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 16),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(12),
      ),
      child: const Column(
        children: [
          Icon(Icons.task_alt, size: 32, color: AppColors.primary),
          SizedBox(height: 8),
          Text(
            'No deliveries need proof right now',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
          SizedBox(height: 4),
          Text(
            'Deliveries that are out for delivery appear here. Completed '
            'deliveries are under Completed in Deliveries.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: AppColors.textLight),
          ),
        ],
      ),
    );
  }
}

class _OrderChoice extends StatelessWidget {
  const _OrderChoice({
    super.key,
    required this.delivery,
    required this.selected,
    required this.showRef,
    required this.onTap,
  });

  final Delivery delivery;
  final bool selected;
  final bool showRef;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final d = delivery;
    return Semantics(
      button: true,
      selected: selected,
      label: 'Order ${d.orderNumber}, ${proofDestinationLine(d)}, ${d.statusLabel}',
      excludeSemantics: true,
      child: Material(
        color: selected ? AppColors.primaryLight : AppColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(
            color: selected ? AppColors.primary : AppColors.border,
            width: selected ? 2 : 1,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: Icon(
                    selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                    size: 20,
                    color: selected ? AppColors.primary : AppColors.textMuted,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      OrderNumberText(
                        d.orderNumber,
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        proofDestinationLine(d),
                        style: const TextStyle(fontSize: 12, color: AppColors.textMedium),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          ProofStatusChip(delivery: d),
                          if (d.isUrgent)
                            const _Chip(text: 'Urgent', fg: AppColors.urgent, bg: AppColors.urgentBg),
                          if (showRef)
                            Text(
                              'Ref …${shortDocumentRef(d.id)}',
                              style: const TextStyle(fontSize: 11, color: AppColors.textLight),
                            ),
                        ],
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

/// "Dr. Ana Reyes · Laguna Clinic" — the doctor and destination, falling back
/// to the combined clinic label on older orders.
String proofDestinationLine(Delivery d) {
  final doctor = d.doctorName;
  final place = d.destinationName ?? d.clinicName;
  if (doctor == null || place.contains(doctor)) return place;
  return '$doctor · $place';
}

/// The selected delivery, shown in full so the rider can confirm it is the
/// right one before taking photos.
class ProofOrderSummary extends StatelessWidget {
  const ProofOrderSummary({super.key, required this.delivery, this.onChange});

  final Delivery delivery;

  /// Choose a different delivery; null hides the control.
  final VoidCallback? onChange;

  @override
  Widget build(BuildContext context) {
    final d = delivery;
    return Card(
      key: const ValueKey('proof-order-summary'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Expanded(
                  child: Text(
                    'Delivery',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                ),
                if (onChange != null)
                  TextButton(
                    key: const ValueKey('proof-change-delivery'),
                    onPressed: onChange,
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(0, 32),
                    ),
                    child: const Text('Change'),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            OrderNumberText(
              d.orderNumber,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 10),
            _SummaryRow(label: 'Doctor', value: d.doctorName ?? 'Not recorded'),
            _SummaryRow(label: 'Clinic', value: d.destinationName ?? d.clinicName),
            _SummaryRow(
              label: 'Destination',
              value: d.clinicAddress.trim().isEmpty ? 'Not recorded' : d.clinicAddress,
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                const SizedBox(
                  width: 92,
                  child: Text('Status', style: TextStyle(fontSize: 12, color: AppColors.textLight)),
                ),
                Flexible(child: ProofStatusChip(delivery: d)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 92,
            child: Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 13, color: AppColors.textDark, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

/// The delivery's status, in the app's status colours.
class ProofStatusChip extends StatelessWidget {
  const ProofStatusChip({super.key, required this.delivery});

  final Delivery delivery;

  @override
  Widget build(BuildContext context) {
    Color bg;
    Color fg;
    switch (delivery.status) {
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
      case 'delivery_failed':
      case 'cancelled':
        bg = AppColors.urgentBg;
        fg = AppColors.urgent;
        break;
      default:
        bg = AppColors.warningBg;
        fg = AppColors.warning;
    }
    return _Chip(text: delivery.statusLabel, fg: fg, bg: bg);
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.text, required this.fg, required this.bg});

  final String text;
  final Color fg;
  final Color bg;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: fg)),
    );
  }
}
