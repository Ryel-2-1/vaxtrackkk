/// Clinic delivery geofence — the Rider-facing wording for the server's
/// decision (functions/src/deliveryGeofence.js). The SERVER decides; this only
/// words its stable codes. Distances are display-only (already rounded by the
/// server); no location decision is ever made on the device.
library;

const String kGeofenceOutside = 'delivery-outside-geofence';
const String kGeofenceStale = 'rider-location-stale';
const String kGeofenceInaccurate = 'rider-location-inaccurate';
const String kGeofenceUnavailable = 'rider-location-unavailable';
const String kGeofenceDestinationInvalid = 'delivery-destination-invalid';

/// Codes meaning "not provably at the clinic right now" — retryable once the
/// Rider's location changes. Never a reason to upload again.
const Set<String> kDeliveryLocationCodes = {
  kGeofenceOutside,
  kGeofenceStale,
  kGeofenceInaccurate,
  kGeofenceUnavailable,
  kGeofenceDestinationInvalid,
};

/// Codes meaning the delivery can no longer be completed by this Rider.
const Set<String> kNotCompletableCodes = {'not-assigned-rider', 'invalid-status-transition'};

const String kStaleLocationMessage =
    'Your location is out of date. Wait for VaxTrack to refresh your location, then try again.';
const String kInaccurateLocationMessage =
    'Your GPS accuracy is too low to confirm that you are at the clinic. Move to an open area and try again.';
const String kTrackingStoppedMessage = 'Location sharing must be active before completing this delivery.';
const String kDestinationInvalidMessage =
    "This order's clinic location is not configured correctly. Contact the Dispatcher.";
const String kNotCompletableMessage = 'This delivery is no longer assigned to you or cannot be completed.';

String outsideGeofenceMessage(int distanceM, int radiusM) =>
    'You are $distanceM m from the clinic. Move within the $radiusM m delivery area before submitting.';

/// True for every geofence or no-longer-completable refusal.
bool isDeliveryLocationRefusal(String code) =>
    kDeliveryLocationCodes.contains(code) || kNotCompletableCodes.contains(code);

/// The Rider-facing message for a server [code], or null when [code] is not a
/// delivery-location refusal. [info] is the server's safe detail payload.
String? deliveryLocationMessage(String code, {Map<Object?, Object?>? info, String? serverMessage}) {
  switch (code) {
    case kGeofenceOutside:
      final distance = info?['distanceM'];
      final radius = info?['radiusM'];
      if (distance is num && radius is num) {
        return outsideGeofenceMessage(distance.round(), radius.round());
      }
      return serverMessage ?? 'You are outside the clinic delivery area. Move closer before submitting.';
    case kGeofenceStale:
      return kStaleLocationMessage;
    case kGeofenceInaccurate:
      return kInaccurateLocationMessage;
    case kGeofenceUnavailable:
      return kTrackingStoppedMessage;
    case kGeofenceDestinationInvalid:
      return kDestinationInvalidMessage;
    case 'not-assigned-rider':
    case 'invalid-status-transition':
      return kNotCompletableMessage;
  }
  return null;
}
