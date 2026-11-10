import 'package:flutter/material.dart';

/// VaxTrack Rider motion.
///
/// Motion here is feedback, never decoration: it acknowledges a tap, makes a
/// status change readable, shows how far a submission has got, and marks the
/// one moment that earns more, a delivery completed. Everything decelerates
/// into place (Material 3 emphasized easing) and exits faster than it enters.
///
/// Android's "Remove animations" setting (MediaQuery.disableAnimations) takes
/// the movement out: no slides, scales, spins or growing layouts. What carries
/// meaning stays, as a short fade or an instant change: the new state, the
/// error, the completed check.
abstract final class Motion {
  /// Acknowledging a tap: a spinner replacing an icon, a label changing.
  static const Duration quick = Duration(milliseconds: 150);

  /// A status changing in place: sync chip, sharing banner.
  static const Duration state = Duration(milliseconds: 250);

  /// Something appearing that pushes the layout: an error, a notice.
  static const Duration reveal = Duration(milliseconds: 320);

  /// The completed-delivery mark, including a short hold so it is seen.
  static const Duration focal = Duration(milliseconds: 1150);

  static const Curve enter = Easing.emphasizedDecelerate;
  static const Curve exit = Easing.emphasizedAccelerate;
  static const Curve standard = Easing.standard;

  /// True when the rider turned animations off (Android: Remove animations).
  static bool reduced(BuildContext context) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;
}
