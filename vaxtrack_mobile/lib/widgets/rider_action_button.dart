import 'package:flutter/material.dart';

/// The minimum height every full-width Rider action button shares.
const double kRiderActionButtonHeight = 52;

/// The completion action's label, shared by Delivery Detail and the Proof
/// screen. Short enough to sit on one line at normal text size on a 360 dp
/// phone, so it matches "Report Delay" beside it instead of wrapping (the
/// longer "Submit Proof & Complete Delivery" wrapped to two lines there).
const String kSubmitAndCompleteLabel = 'Submit Proof & Complete';

/// A full-width Rider action button ("Submit Proof & Complete", "Report
/// Delay", "Report Delivery Failure", …).
///
/// Buttons stacked together must look like a set: the label always stays on
/// ONE line, so a longer label can never wrap and make its button taller than
/// the one next to it. On a phone too narrow for the label (or at a large
/// text size) the label is scaled down to fit instead of wrapping or being
/// cut off. Every button at the same text size is therefore the same height.
class RiderActionButton extends StatelessWidget {
  const RiderActionButton({
    super.key,
    required this.label,
    required this.icon,
    required this.onPressed,
    this.color,
    this.busy = false,
  });

  final String label;
  final IconData icon;

  /// Null disables the button.
  final VoidCallback? onPressed;

  /// Background colour; null keeps the theme's primary button colour.
  final Color? color;

  /// Shows a small spinner in place of the icon while an action runs.
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton.icon(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: color,
          minimumSize: const Size.fromHeight(kRiderActionButtonHeight),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        ),
        icon: busy
            ? const SizedBox(
                height: 18,
                width: 18,
                child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
              )
            : Icon(icon),
        label: FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(label, maxLines: 1, softWrap: false),
        ),
      ),
    );
  }
}
