import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../utils/feed_errors.dart';
import '../utils/safe_log.dart';

/// Builds a screen from one live feed for the signed-in Rider — opened once,
/// kept across rebuilds, replaced only when the Rider changes or on Retry.
///
/// Why this exists: the Rider screens used to create their Firestore stream in
/// build(). Every rebuild (a keystroke, a progress update, a profile update)
/// handed the StreamBuilder a NEW stream, so it unsubscribed, resubscribed and
/// fell back to its loading spinner — the white flash on the Proof screen.
///
/// The three states stay distinct:
///   * loading — a spinner, for the FIRST load of a feed only;
///   * error   — safe wording ([feedErrorMessage]) and a Retry that opens a
///               NEW subscription (a Firestore listener that errored does not
///               resume by itself). The raw error goes to [logSuppressedError]
///               once per error event — never to the screen;
///   * data    — [builder], including an empty result, which is the screen's
///               own "nothing here" state, not an error.
///
/// Later updates replace the content in place; they never bring the spinner
/// back. A different [riderId] opens that Rider's feed and starts from a clean
/// state, so nothing of the previous Rider's content is shown while it loads.
class RiderFeedBuilder<T> extends StatefulWidget {
  const RiderFeedBuilder({
    super.key,
    required this.riderId,
    required this.open,
    required this.builder,
    required this.component,
    required this.what,
    this.loadingBuilder,
    this.errorBuilder,
  });

  /// The signed-in Rider whose feed this is.
  final String riderId;

  /// Opens the feed for a Rider. Called once per Rider, and again on Retry —
  /// never on an ordinary rebuild.
  final Stream<T> Function(String riderId) open;

  final Widget Function(BuildContext context, T data) builder;

  /// Names the screen in the (privacy-safe) log line.
  final String component;

  /// Names the feed in the Rider-facing error, e.g. 'your deliveries'.
  final String what;

  /// Replaces the default full-area spinner (e.g. to keep the rest of a page).
  final WidgetBuilder? loadingBuilder;

  /// Replaces the default full-area error (e.g. to keep a Sign Out button
  /// reachable). Receives the safe message and a Retry that reconnects.
  final Widget Function(BuildContext context, String message, VoidCallback retry)? errorBuilder;

  @override
  State<RiderFeedBuilder<T>> createState() => _RiderFeedBuilderState<T>();
}

class _RiderFeedBuilderState<T> extends State<RiderFeedBuilder<T>> {
  late Stream<T> _stream;

  /// Bumped on every (re)connection. Keys the StreamBuilder so a new Rider or
  /// a Retry starts from a clean snapshot — StreamBuilder would otherwise keep
  /// showing the previous stream's last data while the new one loads.
  int _connection = 0;

  @override
  void initState() {
    super.initState();
    _connect();
  }

  @override
  void didUpdateWidget(covariant RiderFeedBuilder<T> old) {
    super.didUpdateWidget(old);
    // Only a different Rider reconnects; a rebuild with a fresh `open`
    // closure for the SAME Rider does not.
    if (old.riderId != widget.riderId) _connect();
  }

  void _connect() {
    _connection += 1;
    _stream = widget.open(widget.riderId).transform(
          StreamTransformer<T, T>.fromHandlers(
            handleError: (error, stack, sink) {
              logSuppressedError(widget.component, 'live feed failed', error, stack);
              sink.addError(error, stack);
            },
          ),
        );
  }

  void _retry() {
    if (mounted) setState(_connect);
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<T>(
      key: ValueKey(_connection),
      stream: _stream,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          final message = feedErrorMessage(snapshot.error!, what: widget.what);
          return widget.errorBuilder?.call(context, message, _retry) ??
              RiderFeedError(message: message, onRetry: _retry);
        }
        if (snapshot.connectionState == ConnectionState.none ||
            snapshot.connectionState == ConnectionState.waiting) {
          return widget.loadingBuilder?.call(context) ??
              const Center(child: CircularProgressIndicator());
        }
        // A live feed never closes on its own; one that ended without a value
        // has nothing to show, so it is offered as a failure with Retry.
        if (!snapshot.hasData && null is! T) {
          final message = feedErrorMessage(StateError('feed closed'), what: widget.what);
          return widget.errorBuilder?.call(context, message, _retry) ??
              RiderFeedError(message: message, onRetry: _retry);
        }
        return widget.builder(context, snapshot.data as T);
      },
    );
  }
}

/// The default feed failure: the safe message and a Retry that reconnects.
class RiderFeedError extends StatelessWidget {
  const RiderFeedError({super.key, required this.message, this.onRetry, this.footer});

  final String message;

  /// Reconnects the feed. Null hides Retry (nothing to reconnect).
  final VoidCallback? onRetry;

  /// Extra content kept reachable under the error (e.g. Sign Out).
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_outlined, size: 40, color: AppColors.textLight),
            const SizedBox(height: 12),
            Text(
              message,
              key: const ValueKey('feed-error-message'),
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 14, color: AppColors.textDark),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              OutlinedButton.icon(
                key: const ValueKey('feed-retry'),
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
            if (footer != null) ...[
              const SizedBox(height: 24),
              footer!,
            ],
          ],
        ),
      ),
    );
  }
}
