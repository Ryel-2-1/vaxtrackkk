/// What the in-app Google Navigation screen (dev harness only) asks Google for,
/// and what it tells the rider about Google's answer.
///
/// The Navigation SDK cannot be given VaxTrack's saved route. Its
/// `setDestinations` takes waypoints plus either routing preferences or a route
/// token minted by Google's own (billed) Routes / Route Optimization APIs —
/// never an outside polyline such as the Valhalla plan — and it reroutes with
/// Google's own logic when the rider leaves its route. So the route it guides
/// on is Google's, is never described as the VaxTrack plan, and is never used
/// as a deviation baseline (the server measures against the saved plan).
///
/// Pure: no plugin import, so it is unit-tested directly. Statuses are matched
/// by the plugin's `NavigationRouteStatus` value names.
library;

/// Motorcycle routing without the roads the VaxTrack plan rejects. Google may
/// still use them where it has no alternative, and VaxTrack cannot check.
const bool kGoogleAvoidHighways = true;
const bool kGoogleAvoidTolls = true;
const bool kGoogleAvoidFerries = true;

/// Shown above Google's map while it guides.
const String kGoogleDirectionsLabel =
    'Google’s directions, not the VaxTrack plan. Google may reroute; '
    'VaxTrack checks your position against the plan, not this route.';

/// The rider-facing outcome of `setDestinations`, by status name. Null for
/// `statusOk`. A missing two-wheeler mode is refused — there is no car
/// fallback.
String? googleRouteStatusMessage(String statusName) {
  switch (statusName) {
    case 'statusOk':
      return null;
    case 'travelModeUnsupported':
      return 'Google has no motorcycle directions for this trip. VaxTrack does not '
          'switch to car directions — follow the VaxTrack route.';
    case 'routeNotFound':
      return 'Google found no motorcycle route to this destination. Follow the VaxTrack route.';
    case 'networkError':
      return 'No connection to Google. Check your data, then try again, or follow the VaxTrack route.';
    case 'locationUnavailable':
      return 'Your location is not available yet. Move to open sky, then try again.';
    case 'quotaExceeded':
    case 'apiKeyNotAuthorized':
      return 'In-app Google directions are not available on this build. Follow the VaxTrack route.';
    default:
      return 'Google could not plan directions. Follow the VaxTrack route.';
  }
}
