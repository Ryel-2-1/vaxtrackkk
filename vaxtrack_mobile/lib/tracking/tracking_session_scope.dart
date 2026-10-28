import 'package:flutter/widgets.dart';

import 'rider_tracking_controller.dart';
import 'tracking_contract.dart';
import 'tracking_lifecycle.dart';

/// Keeps the app-wide [RiderTrackingController] attached to the signed-in
/// rider for as long as the signed-in shell (HomeScreen) is shown, and
/// forwards the app lifecycle to it.
///
/// It holds the [TrackingAttachment] its own attach returned and releases
/// exactly that on dispose. A remounted shell — whose initState may run before
/// OR after this one's dispose — attaches again first or later; either way
/// this release is ignored once a newer attach exists, so it can never leave a
/// signed-in rider detached ("Sign in to start navigation").
class TrackingSessionScope extends StatefulWidget {
  const TrackingSessionScope({
    super.key,
    required this.controller,
    required this.riderUid,
    required this.ordersFor,
    required this.child,
  });

  final RiderTrackingController controller;

  /// Firebase Auth's current user (null when signed out).
  final String? riderUid;
  final Stream<List<TrackedOrder>> Function(String riderUid) ordersFor;
  final Widget child;

  @override
  State<TrackingSessionScope> createState() => _TrackingSessionScopeState();
}

class _TrackingSessionScopeState extends State<TrackingSessionScope> with WidgetsBindingObserver {
  TrackingAttachment? _attachment;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _attach(widget.riderUid);
  }

  void _attach(String? uid) {
    _attachment = uid == null ? null : widget.controller.attach(uid, widget.ordersFor(uid));
  }

  @override
  void didUpdateWidget(TrackingSessionScope old) {
    super.didUpdateWidget(old);
    if (old.riderUid == widget.riderUid && identical(old.controller, widget.controller)) return;
    // Signed out, or another rider: release this scope's claim, then claim anew.
    old.controller.detach(_attachment);
    _attach(widget.riderUid);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Locking the phone or switching apps (Google Maps) never stops a running
    // stream (see foregroundForLifecycle); returning re-checks and starts what
    // had to wait.
    final foreground = foregroundForLifecycle(state);
    if (foreground != null) widget.controller.setForeground(foreground);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // Leaving the signed-in shell stops sharing — unless a newer shell has
    // already attached (then this old claim is ignored).
    widget.controller.detach(_attachment, reason: kEndReasonTrackingStopped);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
