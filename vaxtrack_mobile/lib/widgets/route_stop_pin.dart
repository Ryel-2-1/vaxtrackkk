import 'package:flutter/material.dart';

class RouteStopPin extends StatelessWidget {
  const RouteStopPin({super.key, required this.color, required this.size, this.number});

  final Color color;
  final double size;
  final String? number;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size * 1.25,
      child: CustomPaint(
        painter: _PinShape(color),
        child: Align(
          alignment: const Alignment(0, -1 / 3),
          child: Container(
            width: size * 0.5,
            height: size * 0.5,
            alignment: Alignment.center,
            decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
            child: number == null
                ? Icon(Icons.flag, size: size * 0.32, color: color)
                : FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(number!, style: TextStyle(fontSize: size * 0.3, fontWeight: FontWeight.w800, color: color, height: 1)),
                  ),
          ),
        ),
      ),
    );
  }
}

class _PinShape extends CustomPainter {
  const _PinShape(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    // The map anchors the marker at the midpoint of its bottom edge.
    final outline = Path()
      ..moveTo(w / 2, h)
      ..cubicTo(w * 0.28, h * 0.82, 0, h * 0.60, 0, h * 0.40)
      ..cubicTo(0, h * 0.18, w * 0.22, 0, w / 2, 0)
      ..cubicTo(w * 0.78, 0, w, h * 0.18, w, h * 0.40)
      ..cubicTo(w, h * 0.60, w * 0.72, h * 0.82, w / 2, h)
      ..close();
    canvas.drawPath(outline, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_PinShape oldDelegate) => color != oldDelegate.color;
}
