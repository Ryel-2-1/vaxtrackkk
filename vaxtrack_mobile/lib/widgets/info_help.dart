import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Circled information control for mouse, keyboard and touch users.
class InfoHelp extends StatefulWidget {
  const InfoHelp({super.key, required this.message, this.title = 'More information'});

  final String message;
  final String title;

  @override
  State<InfoHelp> createState() => _InfoHelpState();
}

class _InfoHelpState extends State<InfoHelp> {
  final _tooltipKey = GlobalKey<TooltipState>();

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      key: _tooltipKey,
      message: widget.message,
      excludeFromSemantics: true,
      triggerMode: TooltipTriggerMode.tap,
      waitDuration: const Duration(milliseconds: 300),
      showDuration: const Duration(seconds: 10),
      constraints: const BoxConstraints(maxWidth: 320),
      padding: const EdgeInsets.all(12),
      textStyle: const TextStyle(fontSize: 13, height: 1.5, color: AppColors.textDark),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.border),
        boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 12)],
      ),
      child: Semantics(
        container: true,
        button: true,
        label: '${widget.title}. ${widget.message}',
        onTap: () => _tooltipKey.currentState?.ensureTooltipVisible(),
        child: ExcludeSemantics(
          child: IconButton(
            onPressed: () => _tooltipKey.currentState?.ensureTooltipVisible(),
            icon: const Icon(Icons.info_outline, size: 20, color: AppColors.primary),
            constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
            padding: const EdgeInsets.all(8),
          ),
        ),
      ),
    );
  }
}

class InfoHeading extends StatelessWidget {
  const InfoHeading({super.key, required this.title, required this.message});

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: Semantics(
          container: true,
          header: true,
          child: Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        )),
        InfoHelp(title: 'About $title', message: message),
      ],
    );
  }
}
