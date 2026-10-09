import 'package:flutter/material.dart';

/// An order number, always shown whole on a single line.
///
/// Order numbers such as `VT-ORD-17910141845935-59WI` are identifiers, not
/// prose. Laid out as ordinary text in a narrow column they wrapped at every
/// hyphen ("VT-ORD-" / "17910141845935-" / "59WI"), and a segment longer than
/// the column was even split mid-digits; the Dashboard card instead cut them
/// off with an ellipsis. Neither is acceptable for a value a rider reads back
/// to a clinic.
///
/// So the number is laid out on one line at its natural width and, only when
/// that is wider than the space available (a very narrow phone, or a large
/// system text size), scaled down to fit. It is never wrapped, never
/// ellipsized and never needs horizontal scrolling. Callers give it the full
/// width of the card rather than a column squeezed between other widgets, so
/// on ordinary phones no scaling happens at all.
class OrderNumberText extends StatelessWidget {
  const OrderNumberText(this.orderNumber, {super.key, this.style});

  final String orderNumber;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: FittedBox(
        fit: BoxFit.scaleDown,
        alignment: Alignment.centerLeft,
        child: Text(
          orderNumber,
          maxLines: 1,
          softWrap: false,
          style: style,
        ),
      ),
    );
  }
}
