import 'package:flutter/material.dart';

import '../models/delivery.dart';
import '../theme/app_theme.dart';

/// Separate, wrapping request text: never merged into a status or ETA chip.
class RequestedArrivalText extends StatelessWidget {
  const RequestedArrivalText({super.key, required this.delivery});

  final Delivery delivery;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message:
          'Arrival at the destination, in Philippine time. '
          'A planning request, not a guaranteed ETA.',
      child: Text(
        delivery.requestedArrivalNote,
        softWrap: true,
        style: const TextStyle(
          fontSize: 12,
          height: 1.4,
          color: AppColors.textMuted,
        ),
      ),
    );
  }
}
