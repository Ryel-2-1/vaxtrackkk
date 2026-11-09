import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/motion.dart';

/// Stacks the outgoing and incoming child at the top, so a swap never jumps.
Widget _topStack(Widget? current, List<Widget> previous) => Stack(
  alignment: Alignment.topCenter,
  children: [...previous, ?current],
);

/// A message that appears and disappears in place: an error, a notice.
///
/// [child] null shows nothing. The space opens smoothly and the message fades
/// in from just above, so the rider sees it arrive instead of the screen
/// jumping. A different [identity] (usually the message text) swaps one
/// message for the next the same way.
class FeedbackReveal extends StatelessWidget {
  const FeedbackReveal({super.key, this.child, this.identity});

  final Widget? child;
  final Object? identity;

  @override
  Widget build(BuildContext context) {
    final reduced = Motion.reduced(context);
    return AnimatedSize(
      duration: reduced ? Duration.zero : Motion.reveal,
      curve: Motion.enter,
      alignment: Alignment.topCenter,
      child: AnimatedSwitcher(
        duration: reduced ? Motion.quick : Motion.reveal,
        reverseDuration: Motion.quick,
        switchInCurve: Motion.enter,
        switchOutCurve: Motion.exit,
        layoutBuilder: _topStack,
        transitionBuilder: (child, animation) {
          final fade = FadeTransition(opacity: animation, child: child);
          if (reduced) return fade;
          return SlideTransition(
            position: Tween(
              begin: const Offset(0, -0.12),
              end: Offset.zero,
            ).animate(animation),
            child: fade,
          );
        },
        child: child == null
            ? const SizedBox(
                width: double.infinity,
                key: ValueKey('feedback-none'),
              )
            : KeyedSubtree(
                key: ValueKey(identity ?? 'feedback'),
                child: child!,
              ),
      ),
    );
  }
}

/// A status that changes in place (sync chip, location-sharing banner).
///
/// The old state fades out while the new one settles in from a hair smaller,
/// Material's fade-through. Only a change of [stateKey] animates; text that
/// updates within the same state just updates.
class StateSwap extends StatelessWidget {
  const StateSwap({
    super.key,
    required this.stateKey,
    required this.child,
    this.resize = true,
    this.alignment = Alignment.topCenter,
  });

  final Object stateKey;
  final Widget child;

  /// Animate the size change between states (off for fixed-size slots).
  final bool resize;
  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    final reduced = Motion.reduced(context);
    final swap = AnimatedSwitcher(
      duration: reduced ? Motion.quick : Motion.state,
      reverseDuration: Motion.quick,
      switchInCurve: Motion.enter,
      switchOutCurve: Motion.exit,
      layoutBuilder: (current, previous) => Stack(
        alignment: alignment,
        children: [...previous, ?current],
      ),
      transitionBuilder: (child, animation) {
        final fade = FadeTransition(opacity: animation, child: child);
        if (reduced) return fade;
        return ScaleTransition(
          scale: Tween(begin: 0.96, end: 1.0).animate(animation),
          child: fade,
        );
      },
      child: KeyedSubtree(key: ValueKey(stateKey), child: child),
    );
    if (!resize) return swap;
    return AnimatedSize(
      duration: reduced ? Duration.zero : Motion.state,
      curve: Motion.enter,
      alignment: alignment is Alignment
          ? alignment as Alignment
          : Alignment.topCenter,
      child: swap,
    );
  }
}

/// How far a proof or completion submission has got.
///
/// The label says what is happening now; the bar fills step by step, so a
/// slow photo upload on weak signal reads as progress rather than a frozen
/// screen. The small spinner keeps showing activity within a step.
class SubmissionProgress extends StatelessWidget {
  const SubmissionProgress({
    super.key,
    required this.text,
    required this.fraction,
    this.textKey,
  });

  final String text;

  /// 0..1; null shows the label without a bar.
  final double? fraction;
  final Key? textKey;

  @override
  Widget build(BuildContext context) {
    final reduced = Motion.reduced(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const SizedBox(
              height: 16,
              width: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: StateSwap(
                stateKey: text,
                resize: false,
                alignment: Alignment.centerLeft,
                child: Text(
                  text,
                  key: textKey,
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.textMedium,
                  ),
                ),
              ),
            ),
          ],
        ),
        if (fraction != null) ...[
          const SizedBox(height: 8),
          TweenAnimationBuilder<double>(
            tween: Tween(end: fraction!.clamp(0.0, 1.0)),
            duration: reduced ? Duration.zero : Motion.reveal,
            curve: Motion.enter,
            builder: (context, value, _) => ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: value,
                minHeight: 6,
                color: AppColors.primary,
                backgroundColor: AppColors.primaryLight,
                semanticsLabel: 'Submission progress',
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// The completed-delivery mark: a green disc settles in, the check draws
/// itself, and "Delivered" fades up. Driven by [progress] (0..1) so its owner
/// decides when to close; with animations off it is drawn complete.
class DeliveredMark extends StatelessWidget {
  const DeliveredMark({
    super.key,
    required this.progress,
    this.label = 'Delivered',
  });

  final Animation<double> progress;
  final String label;

  @override
  Widget build(BuildContext context) {
    final reduced = Motion.reduced(context);
    return Semantics(
      liveRegion: true,
      label: label,
      child: AnimatedBuilder(
        animation: progress,
        builder: (context, _) {
          final t = reduced ? 1.0 : progress.value;
          double phase(double from, double to) => Motion.enter.transform(
            ((t - from) / (to - from)).clamp(0.0, 1.0),
          );
          final disc = phase(0.0, 0.32);
          final check = phase(0.2, 0.58);
          final text = phase(0.4, 0.68);
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Transform.scale(
                scale: 0.6 + 0.4 * disc,
                child: Opacity(
                  opacity: disc,
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: const BoxDecoration(
                      color: AppColors.primary,
                      shape: BoxShape.circle,
                    ),
                    child: CustomPaint(painter: _CheckPainter(check)),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Opacity(
                opacity: text,
                child: Transform.translate(
                  offset: Offset(0, 6 * (1 - text)),
                  child: Text(
                    label,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w800,
                      color: AppColors.textDark,
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _CheckPainter extends CustomPainter {
  _CheckPainter(this.t);

  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    if (t <= 0) return;
    final s = size.width;
    final path = Path()
      ..moveTo(s * 0.29, s * 0.52)
      ..lineTo(s * 0.44, s * 0.66)
      ..lineTo(s * 0.72, s * 0.37);
    final paint = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = s * 0.085
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final metrics = path.computeMetrics().toList();
    final total = metrics.fold<double>(0, (sum, m) => sum + m.length);
    var remaining = total * math.min(1.0, t);
    for (final m in metrics) {
      if (remaining <= 0) break;
      final len = math.min(m.length, remaining);
      canvas.drawPath(m.extractPath(0, len), paint);
      remaining -= len;
    }
  }

  @override
  bool shouldRepaint(_CheckPainter old) => old.t != t;
}
