/// The one place the Rider app builds its external Google Maps hand-off links.
///
/// Riders deliver by motorcycle, so every directions link asks Google Maps for
/// TWO-WHEELER routing (Google's motorcycle mode, available in the Philippines)
/// and opens straight into navigation. It is never `driving` (a car route can
/// avoid roads a motorcycle can use and vice versa) and never `bicycling` (a
/// pedal-bike route).
///
/// Uses Google's universal HTTPS Maps URL (`/maps/dir/?api=1`), which opens the
/// Maps app when installed and the browser otherwise. The origin is omitted on
/// purpose so Maps starts from the device's current location — which is also
/// what lets `dir_action=navigate` start turn-by-turn instead of a preview.
///
/// Google ignores `travelmode=two-wheeler` where it has no two-wheeler routing
/// (it depends on where the device is), and there is no way to detect that from
/// the app — hence [motorcycleModeNote], shown beside every hand-off button.
///
/// Pure: no Flutter or Firebase imports, so it is unit-tested directly.
library;

/// Google Maps' value for motorcycles. NOT `driving`, NOT `bicycling`.
const String googleMapsTravelMode = 'two-wheeler';

/// Opens turn-by-turn navigation (current location → destination) rather than
/// just showing the route.
const String googleMapsDirAction = 'navigate';

/// Short rider-facing hint for when Google Maps does not honour the mode.
const String motorcycleModeNote =
    'Opens in motorcycle mode. If Google Maps shows car directions, '
    'tap the motorcycle option.';

/// What a hand-off does NOT carry. A Maps URL takes stops, never a route, so
/// Google computes its own roads between them — possibly ones the VaxTrack
/// plan avoids — and VaxTrack cannot see or check that route. Shown beside
/// every hand-off button, with [motorcycleModeNote].
const String googleRouteNote =
    'Google Maps chooses its own roads, which may differ from the VaxTrack plan. '
    'Where they differ, follow the plan.';

/// `lat,lng` exactly as Google Maps expects it.
String googleMapsCoord(double lat, double lng) => '$lat,$lng';

/// Directions from the device's current location to [destination], through
/// [waypoints] in the order given. Both are `lat,lng` strings (or place text).
///
/// Encoding is left to [Uri.https], which percent-encodes the `,` and the `|`
/// waypoint separator as Google requires.
Uri googleMapsDirectionsUrl({
  required String destination,
  List<String> waypoints = const [],
}) {
  final params = <String, String>{
    'api': '1',
    'destination': destination,
    if (waypoints.isNotEmpty) 'waypoints': waypoints.join('|'),
    'travelmode': googleMapsTravelMode,
    'dir_action': googleMapsDirAction,
  };
  return Uri.https('www.google.com', '/maps/dir/', params);
}

/// Single-stop navigation to a clinic pin.
Uri googleMapsDestinationUrl(double lat, double lng) =>
    googleMapsDirectionsUrl(destination: googleMapsCoord(lat, lng));
