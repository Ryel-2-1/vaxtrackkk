import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

Future<bool> confirmSignOut(BuildContext context, {int waiting = 0}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Are you sure you want to sign out?'),
      content: Text(
        waiting == 0
            ? 'You’ll need to sign in again to access VaxTrack.'
            : '${waiting == 1 ? 'One delivery' : '$waiting deliveries'} saved offline '
                  '${waiting == 1 ? 'has' : 'have'} not been sent yet. They stay on this phone and are '
                  'sent the next time you sign in with a connection.',
      ),
      actions: [
        TextButton(
          autofocus: true,
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: () => Navigator.pop(dialogContext, true),
          style: ElevatedButton.styleFrom(backgroundColor: AppColors.urgent),
          child: const Text('Sign Out'),
        ),
      ],
    ),
  );
  return confirmed == true;
}
