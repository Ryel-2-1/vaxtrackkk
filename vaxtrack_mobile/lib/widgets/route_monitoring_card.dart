import 'package:flutter/material.dart';
import 'info_help.dart';

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
    return const Card(
      child: Padding(
        padding: EdgeInsets.all(16),
        child: InfoHeading(
          title: 'Route monitoring',
          message: 'Monitoring is available during an active delivery. '
              'Open an active delivery and start route monitoring for that trip.',
        ),
      ),
    );
  }
}
