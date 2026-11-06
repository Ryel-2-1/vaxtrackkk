import 'package:flutter/material.dart';

import '../environment.dart';

/// The app's own icon, matching the launcher icon of the running build:
/// green for production, amber for staging (flutter_launcher_icons-*.yaml).
/// bootstrap.dart sets [environment] before the app is mounted; tests and
/// anything earlier get the production icon.
class AppBranding {
  AppBranding._();

  static AppEnvironment environment = AppEnvironment.production;

  static String get iconAsset => environment == AppEnvironment.staging
      ? 'branding/vaxtrack-icon-staging.png'
      : 'branding/vaxtrack-icon-production.png';

  static bool get isStaging => environment == AppEnvironment.staging;
}

/// The VaxTrack icon, rounded like the launcher icon.
class VaxTrackLogo extends StatelessWidget {
  const VaxTrackLogo({super.key, this.size = 84});

  final double size;

  @override
  Widget build(BuildContext context) {
    final px = (size * MediaQuery.devicePixelRatioOf(context)).round();
    return Semantics(
      label: 'VaxTrack',
      image: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(size * 0.24),
        child: Image.asset(
          AppBranding.iconAsset,
          width: size,
          height: size,
          // The source is 1024 px; decode only what is shown.
          cacheWidth: px,
          cacheHeight: px,
          errorBuilder: (_, _, _) => Container(
            width: size,
            height: size,
            color: const Color(0xFF136A47),
            alignment: Alignment.center,
            child: Icon(Icons.local_shipping, color: Colors.white, size: size * 0.5),
          ),
        ),
      ),
    );
  }
}
