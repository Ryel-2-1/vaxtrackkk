import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../tracking/rider_tracking_controller.dart';
import '../tracking/tracking_lifecycle.dart';

/// Rider-facing state of delivery location sharing, with a recovery action
/// for every state that needs one. The explanation is shown BEFORE the system
/// permission prompt; nothing is requested silently.
class TrackingStatusBanner extends StatelessWidget {
  const TrackingStatusBanner({super.key, required this.controller});

  final RiderTrackingController controller;

  /// Texts per status (also used by tests).
  static const Map<TrackingStatus, String> messages = {
    TrackingStatus.needsPermission:
        'You have an active delivery. VaxTrack shares your location with dispatch, '
        'admins and the Med Rep who placed the order — only while you have an active '
        'delivery. A notification shows whenever it is shared, and it stops '
        'automatically when your deliveries end.',
    TrackingStatus.permissionDenied:
        'Location permission was declined, so your position is not shared for your '
        'active delivery. You can allow it now.',
    TrackingStatus.permissionBlocked:
        'Location permission is turned off for VaxTrack. Turn it on in app settings, '
        'then come back and tap Retry.',
    TrackingStatus.locationOff:
        'Device location is off, so your position is not shared for your active '
        'delivery. Turn on location, then tap Retry.',
    TrackingStatus.error: 'Your location could not be read. Check that location is on, then retry.',
    TrackingStatus.waitingForApp:
        'You have an active delivery. Location sharing starts now that VaxTrack is open.',
  };

  /// Shown under the sharing state when Android notifications are off.
  static const String notificationsHiddenMessage =
      'Notifications are off for VaxTrack, so the "sharing location" notification '
      'is hidden. Your location is still shared for your active delivery.';

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final status = controller.status;
        switch (status) {
          case TrackingStatus.idle:
            return const SizedBox.shrink();
          case TrackingStatus.tracking:
          case TrackingStatus.navigating:
            final sharing = status == TrackingStatus.navigating
                ? 'Navigating a delivery — sharing your location (route monitoring on).'
                : 'Sharing your location for ${controller.activeOrderIds.length} active '
                    'deliver${controller.activeOrderIds.length == 1 ? 'y' : 'ies'}.';
            return _card(
              icon: Icons.my_location,
              color: AppColors.primary,
              text: controller.notificationsAllowed ? sharing : '$sharing\n$notificationsHiddenMessage',
              actions: controller.notificationsAllowed
                  ? const []
                  : [_button('Notification settings', controller.openAppSettings)],
            );
          case TrackingStatus.waitingForApp:
            return _card(
              icon: Icons.schedule,
              color: Colors.orange.shade800,
              text: messages[status]!,
              actions: [_button('Retry', controller.retry)],
            );
          case TrackingStatus.needsPermission:
            return _card(
              icon: Icons.privacy_tip_outlined,
              color: Colors.orange.shade800,
              text: messages[status]!,
              actions: [_button('Allow location', controller.allowLocation)],
            );
          case TrackingStatus.permissionDenied:
            return _card(
              icon: Icons.location_disabled,
              color: Colors.orange.shade800,
              text: messages[status]!,
              actions: [_button('Allow location', controller.allowLocation)],
            );
          case TrackingStatus.permissionBlocked:
            return _card(
              icon: Icons.location_disabled,
              color: Colors.red.shade700,
              text: messages[status]!,
              actions: [
                _button('Open app settings', controller.openAppSettings),
                _button('Retry', controller.retry),
              ],
            );
          case TrackingStatus.locationOff:
            return _card(
              icon: Icons.location_off,
              color: Colors.red.shade700,
              text: messages[status]!,
              actions: [
                _button('Location settings', controller.openLocationSettings),
                _button('Retry', controller.retry),
              ],
            );
          case TrackingStatus.error:
            return _card(
              icon: Icons.error_outline,
              color: Colors.red.shade700,
              text: controller.lastError ?? messages[status]!,
              actions: [_button('Retry', controller.retry)],
            );
        }
      },
    );
  }

  Widget _button(String label, Future<void> Function() onTap) => TextButton(
        onPressed: () => onTap(),
        child: Text(label),
      );

  Widget _card({
    required IconData icon,
    required Color color,
    required String text,
    List<Widget> actions = const [],
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: color, size: 20),
              const SizedBox(width: 10),
              Expanded(child: Text(text, style: const TextStyle(fontSize: 13, color: AppColors.textDark))),
            ],
          ),
          if (actions.isNotEmpty)
            Align(alignment: Alignment.centerRight, child: Wrap(spacing: 4, children: actions)),
        ],
      ),
    );
  }
}
