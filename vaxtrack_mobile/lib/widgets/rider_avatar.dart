import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../utils/person_initials.dart';

/// The rider's avatar: their profile photo, else up to three initials — the
/// same rule the web uses for staff and riders (2026-11-15). A photo that
/// fails to load falls back to the initials.
class RiderAvatar extends StatelessWidget {
  const RiderAvatar({super.key, required this.name, this.photoUrl, this.size = 72});

  final String name;

  /// From AppUser.displayPhotoUrl; null shows initials.
  final String? photoUrl;
  final double size;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(size / 4);
    final initials = Container(
      key: const ValueKey('rider-avatar-initials'),
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: AppColors.primaryLight, borderRadius: radius),
      child: Text(
        initialsOf(name),
        style: TextStyle(
          fontSize: size * 0.34,
          fontWeight: FontWeight.w800,
          color: AppColors.primary,
          letterSpacing: -0.5,
        ),
      ),
    );
    final url = photoUrl;
    if (url == null || url.isEmpty) return initials;
    return ClipRRect(
      borderRadius: radius,
      child: Image.network(
        url,
        key: const ValueKey('rider-avatar-photo'),
        width: size,
        height: size,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) => initials,
        loadingBuilder: (context, child, progress) => progress == null ? child : initials,
      ),
    );
  }
}
