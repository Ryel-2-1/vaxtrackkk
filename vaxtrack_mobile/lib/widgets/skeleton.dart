import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// Skeleton loading: grey placeholders in the shape of what is coming, gently
/// pulsing, instead of a lone spinner. Only the placeholder blocks pulse (the
/// cards around them stay still), and nothing moves when the platform asks
/// for reduced motion.
class Shimmer extends StatefulWidget {
  const Shimmer({super.key, required this.child});

  final Widget child;

  @override
  State<Shimmer> createState() => _ShimmerState();
}

class _ShimmerState extends State<Shimmer> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _SkeletonPulse(notifier: _c, child: widget.child);
}

class _SkeletonPulse extends InheritedNotifier<Animation<double>> {
  const _SkeletonPulse({required super.notifier, required super.child});

  static double of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_SkeletonPulse>()?.notifier?.value ?? 0;
}

/// One placeholder block.
class SkeletonBox extends StatelessWidget {
  const SkeletonBox({super.key, this.width, required this.height, this.radius = 8});

  final double? width;
  final double height;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final t = Curves.easeInOut.transform(_SkeletonPulse.of(context));
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: Color.lerp(AppColors.border, const Color(0xFFF1F5F9), t),
        borderRadius: BorderRadius.circular(radius),
      ),
    );
  }
}

/// A delivery card's shape: order line, destination, two chips.
class SkeletonDeliveryCard extends StatelessWidget {
  const SkeletonDeliveryCard({super.key});

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border),
        ),
        child: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [SkeletonBox(width: 140, height: 14), Spacer(), SkeletonBox(width: 70, height: 20, radius: 10)]),
            SizedBox(height: 12),
            SkeletonBox(width: 200, height: 12),
            SizedBox(height: 8),
            SkeletonBox(width: 160, height: 12),
            SizedBox(height: 12),
            Row(children: [SkeletonBox(width: 64, height: 18, radius: 9), SizedBox(width: 8), SkeletonBox(width: 84, height: 18, radius: 9)]),
          ],
        ),
      );
}

/// A list of delivery cards loading (any delivery feed).
class SkeletonDeliveryList extends StatelessWidget {
  const SkeletonDeliveryList({super.key, this.count = 4});

  final int count;

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Loading',
        liveRegion: true,
        child: Shimmer(
          key: const Key('skeleton-delivery-list'),
          child: ListView(
            physics: const NeverScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [for (var i = 0; i < count; i++) const SkeletonDeliveryCard()],
          ),
        ),
      );
}

/// The rider's home loading: three stat tiles, a section title, delivery cards
/// and the bottom navigation bar, so the app opens into its own shape.
class SkeletonHome extends StatelessWidget {
  const SkeletonHome({super.key});

  @override
  Widget build(BuildContext context) {
    Widget tile() => Expanded(
          child: Container(
            height: 76,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.border),
            ),
            child: const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [SkeletonBox(width: 32, height: 20), SkeletonBox(width: 60, height: 10)],
            ),
          ),
        );
    return Scaffold(
      key: const Key('skeleton-home'),
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Semantics(
          label: 'Loading your deliveries',
          liveRegion: true,
          child: Shimmer(
            child: ListView(
              physics: const NeverScrollableScrollPhysics(),
              padding: const EdgeInsets.all(16),
              children: [
                const SkeletonBox(width: 180, height: 22),
                const SizedBox(height: 16),
                Row(children: [tile(), const SizedBox(width: 10), tile(), const SizedBox(width: 10), tile()]),
                const SizedBox(height: 24),
                const SkeletonBox(width: 150, height: 16),
                const SizedBox(height: 12),
                for (var i = 0; i < 3; i++) const SkeletonDeliveryCard(),
              ],
            ),
          ),
        ),
      ),
      bottomNavigationBar: Container(
        height: 72,
        decoration: const BoxDecoration(color: AppColors.surface, border: Border(top: BorderSide(color: AppColors.border))),
        child: Shimmer(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              for (var i = 0; i < 4; i++)
                const Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [SkeletonBox(width: 24, height: 24, radius: 6), SizedBox(height: 6), SkeletonBox(width: 44, height: 8)],
                ),
            ],
          ),
        ),
      ),
    );
  }
}
