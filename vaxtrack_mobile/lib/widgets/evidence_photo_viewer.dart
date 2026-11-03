import 'package:flutter/material.dart';

/// Opens an existing evidence image for read-only inspection and pinch zoom.
Future<void> showEvidencePhoto(
  BuildContext context, {
  required String title,
  required ImageProvider image,
}) {
  return showDialog<void>(
    context: context,
    builder: (dialogContext) => Dialog(
      insetPadding: const EdgeInsets.all(12),
      backgroundColor: Colors.black,
      child: SafeArea(
        child: SizedBox(
          width: MediaQuery.sizeOf(dialogContext).width,
          height: MediaQuery.sizeOf(dialogContext).height - 24,
          child: Stack(
            children: [
              Center(
                child: InteractiveViewer(
                  minScale: 1,
                  maxScale: 4,
                  child: Image(
                    image: image,
                    fit: BoxFit.contain,
                    errorBuilder: (_, _, _) => const Text(
                      'The image could not be loaded.',
                      style: TextStyle(color: Colors.white),
                    ),
                  ),
                ),
              ),
              Positioned(
                top: 8,
                left: 12,
                right: 8,
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Close photo',
                      onPressed: () => Navigator.of(dialogContext).pop(),
                      icon: const Icon(Icons.close, color: Colors.white),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
