import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// A neutral note about where route monitoring happens.
///
/// WHY THIS SAYS SO LITTLE. It previously rendered a green check with "Within
/// Geofence" and "No deviations detected", plus a line telling the rider that
/// "Geofence status is monitored by the dispatch system". Every one of those
/// strings was `const`: the widget took no arguments, read no stream and
/// received no location, so it announced compliance it had no way to observe.
/// There is no mobile geofence entry/exit detector, no geofence event writer
/// and no rule behind it — the geofence today is admin data entry plus
/// dispatcher-side visualisation.
///
/// A false compliance indicator is worse than none: a rider who has drifted off
/// route sees a green tick and concludes they are fine. So the card now states
/// only what is true — that monitoring exists, and where to find it — and
/// claims nothing about the rider's current position, safety or deviation
/// history.
///
/// It takes no state TODAY because none exists to take. That is not a rule
/// against ever having one: when customer geofencing lands and there is an
/// authoritative monitoring source, this card is the right place to render it.
/// The requirement is only that a compliance claim must come from that source —
/// never from a default, a constant, or the absence of contrary evidence.
class RouteMonitoringCard extends StatelessWidget {
  const RouteMonitoringCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: const Text(
                'Route monitoring',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(height: 12),
            // Informational blue, not the success green this block used to
            // wear. The colour is part of the claim: a green tick reads as
            // "you are compliant" whatever the words next to it say.
            Semantics(
              container: true,
              label:
                  'Route monitoring information. Monitoring is available during '
                  'an active delivery.',
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.infoBg,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.border),
                ),
                child: const Row(
                  children: [
                    ExcludeSemantics(
                      child: Icon(Icons.info_outline, color: AppColors.info, size: 20),
                    ),
                    SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'Monitoring is available during an active delivery.',
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
                          color: AppColors.textMedium,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
            // Where it actually is, and that it is a deliberate act. "Open …
            // AND start" keeps the manual Start button in the sentence: opening
            // a delivery does not begin monitoring, and wording that implied it
            // did would be a smaller version of the same false claim this card
            // was built to remove.
            const Text(
              'Open an active delivery and start route monitoring for that trip.',
              style: TextStyle(fontSize: 11, color: AppColors.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}
