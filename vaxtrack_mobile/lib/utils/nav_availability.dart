import '../models/delivery.dart';

/// Pure, Firebase-free rules for which Rider navigation options a delivery
/// supports. Extracted from the delivery-detail screen so the button gating is
/// unit-testable without a widget or a live Firebase connection.
///
/// Policy (Phase G2 correction): navigation and live location reporting are
/// permitted ONLY while the delivery is `in_transit`. The broad `isActive`
/// getter is intentionally NOT used here — an assigned/loading/delayed delivery
/// must first move (back) to `in_transit` via the existing lifecycle actions.
/// Status normalization is owned by [Delivery] (`in_transit` etc.); this utility
/// only reads the normalized status getters.
class NavigationAvailability {
  const NavigationAvailability({
    required this.inTransit,
    required this.canStartEmbeddedNav,
    required this.canOpenExternalMaps,
    required this.canMonitorRoute,
    required this.usesAddressSearch,
    required this.statusPrompt,
  });

  /// The one status that may show navigation actions.
  final bool inTransit;

  /// In-app Google Navigation (embedded SDK): in_transit + destination pin.
  final bool canStartEmbeddedNav;

  /// External Google Maps handoff: in_transit + (pin OR non-empty address).
  final bool canOpenExternalMaps;

  /// VaxTrack route-compliance monitoring: in_transit + destination pin. (The
  /// monitoring screen still enforces the full eligibility — assignment + a
  /// saved route — before Start; this only gates the button's visibility.)
  final bool canMonitorRoute;

  /// External Maps will use an address search because there is no pin.
  final bool usesAddressSearch;

  /// When non-null, navigation is unavailable BECAUSE OF STATUS and the rider
  /// should act on the lifecycle first. Null while `in_transit` (actions shown)
  /// and for terminal statuses (delivered/cancelled — nothing actionable to
  /// prompt; those show no navigation section at all).
  final String? statusPrompt;

  static NavigationAvailability of(Delivery d) {
    final bool inTransit = d.isInTransit;
    final bool coords = d.hasClinicCoords;
    final bool hasAddress = d.clinicAddress.trim().isNotEmpty;
    return NavigationAvailability(
      inTransit: inTransit,
      canStartEmbeddedNav: inTransit && coords,
      canOpenExternalMaps: inTransit && (coords || hasAddress),
      canMonitorRoute: inTransit && coords,
      usesAddressSearch: inTransit && !coords && hasAddress,
      statusPrompt: _statusPrompt(d),
    );
  }

  static String? _statusPrompt(Delivery d) {
    if (d.isInTransit) return null;
    if (d.isAssigned || d.isLoading) {
      return 'Set this delivery to In Transit before starting navigation.';
    }
    if (d.isDelayed) {
      return 'Return this delivery to In Transit before resuming navigation.';
    }
    // Delivered / cancelled (or any other terminal state): no lifecycle prompt.
    return null;
  }
}
