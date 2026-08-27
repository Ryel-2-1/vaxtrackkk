import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../utils/sync_status.dart';

/// A small, non-blocking chip that tells the rider whether they are viewing
/// server-confirmed data, previously-loaded cached data, or data with a write
/// still waiting to reach the server.
///
/// Intentionally compact and read-only — it never blocks the UI and never
/// claims the rider is "offline" (see [syncStatusFrom]). Colours stay within
/// the existing green (good) / amber (attention) language.
class SyncIndicator extends StatelessWidget {
  const SyncIndicator({super.key, required this.status});

  final SyncStatus status;

  @override
  Widget build(BuildContext context) {
    final Color fg;
    final Color bg;
    final IconData icon;
    switch (status) {
      case SyncStatus.synced:
        fg = AppColors.primary;
        bg = AppColors.primaryLight;
        icon = Icons.cloud_done;
        break;
      case SyncStatus.cached:
        fg = AppColors.warning;
        bg = AppColors.warningBg;
        // "cached" (not "offline"): shows saved data, may occur while online.
        icon = Icons.cached;
        break;
      case SyncStatus.pending:
        fg = AppColors.warning;
        bg = AppColors.warningBg;
        icon = Icons.sync;
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: fg),
          const SizedBox(width: 5),
          Text(
            status.label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: fg,
            ),
          ),
        ],
      ),
    );
  }
}
