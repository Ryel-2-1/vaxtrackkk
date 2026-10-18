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

  /// Shown while sharing: some phones (e.g. vivo) stop background apps unless
  /// the rider allows it in the app's settings.
  static const String backgroundActivityMessage =
      'Keep background activity allowed for reliable location sharing.';

  /// Shown whenever Android notifications are off for VaxTrack. Android still
  /// lets the location service run, but hides its notice — and some phones
  /// stop a hidden service — so reliable sharing is NOT promised.
  static const String notificationsHiddenMessage =
      'Notifications are off for VaxTrack. Android hides the "sharing location" '
      'notice, and sharing may stop while the screen is locked. Turn on '
      'notifications in App settings for reliable delivery tracking.';

  /// Shown until the first position has actually been received.
  static String startingMessage(int deliveries) =>
      'Starting location sharing for $deliveries active '
      'deliver${deliveries == 1 ? 'y' : 'ies'} — your position is not shared yet.';

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
            if (!controller.sharingConfirmed) {
              // Asked for, but no position yet: never shown as sharing.
              return _card(
                icon: Icons.schedule,
                color: Colors.orange.shade800,
                text: [
                  startingMessage(controller.activeOrderIds.length),
                  if (controller.lastError == kNoFixYetMessage) kNoFixYetMessage,
                  if (!controller.notificationsAllowed) notificationsHiddenMessage,
                ].join('\n'),
                actions: [
                  _button('Retry', controller.retry),
                  _button('App settings', controller.openAppSettings),
                ],
              );
            }
            final sharing = status == TrackingStatus.navigating
                ? 'Navigating a delivery — sharing your location (route monitoring on).'
                : 'Sharing your location for ${controller.activeOrderIds.length} active '
                    'deliver${controller.activeOrderIds.length == 1 ? 'y' : 'ies'}.';
            return _card(
              icon: Icons.my_location,
              color: AppColors.primary,
              text: [
                sharing,
                backgroundActivityMessage,
                if (!controller.notificationsAllowed) notificationsHiddenMessage,
              ].join('\n'),
              // The app's system settings page: background activity / battery
              // and notifications both live there. Nothing is changed or
              // requested automatically.
              actions: [_button('App settings', controller.openAppSettings)],
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
