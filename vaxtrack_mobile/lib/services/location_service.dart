import 'package:geolocator/geolocator.dart';

/// One-shot device position for the delivery map preview.
///
/// This service never writes and never prompts. Location permission is asked
/// for only through the rider tracking flow, after its explanation
/// (widgets/tracking_status_banner.dart); until then this returns null and the
/// map keeps its other points. Live location is collected and shared only by
/// the app-wide rider tracking controller (services/rider_tracking_service.dart),
/// which writes the rider's own riderLocations/{uid} document.
class LocationService {
  Future<bool> hasPermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) return false;
    final permission = await Geolocator.checkPermission();
    return permission == LocationPermission.always ||
        permission == LocationPermission.whileInUse;
  }

  Future<Position?> getCurrentPosition() async {
    if (!await hasPermission()) return null;

    return await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
    );
  }
}
