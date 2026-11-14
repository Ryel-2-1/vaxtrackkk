/// Avatar text and photo URL rules shared by the Rider app (2026-11-15).
/// Pure: no Flutter or Firebase import.
library;

/// Up to three initials ("Ryel Jan Espinili" → "RJE"), or "?" when there is no
/// name. A longer name keeps its first two words and its surname. Must stay
/// identical to initialsOf() in vaxtrack-web/src/services/profileModel.js, so
/// a rider looks the same in the app and on every web page.
String initialsOf(String? name) {
  final words = (name ?? '')
      .trim()
      .split(RegExp(r'\s+'))
      .where((w) => w.isNotEmpty)
      .toList();
  final picked = words.length > 3 ? [words[0], words[1], words.last] : words;
  final text = picked.map((w) => w.substring(0, 1)).join().toUpperCase();
  return text.isEmpty ? '?' : text;
}

/// The profile photo URL to display: only an https URL counts, and its update
/// time is added as a version so a replaced photo is not served from a cache.
/// Mirrors profilePhotoUrlOf() in vaxtrack-web/src/services/profileModel.js.
String? profilePhotoDisplayUrl(String? url, DateTime? updatedAt) {
  final value = (url ?? '').trim();
  if (!RegExp(r'^https://\S+$').hasMatch(value)) return null;
  if (updatedAt == null) return value;
  final sep = value.contains('?') ? '&' : '?';
  return '$value${sep}v=${updatedAt.millisecondsSinceEpoch}';
}
