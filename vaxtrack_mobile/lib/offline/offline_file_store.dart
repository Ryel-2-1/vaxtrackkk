import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'offline_delivery_queue.dart';
import 'offline_delivery_record.dart';

/// Offline records as one JSON file, and their photos as copies, in the app's
/// own documents folder (not a cache the system may clear). Private to the
/// app; removed once a record has been sent.
class OfflineFileStore implements OfflineRecordStore {
  OfflineFileStore({Future<Directory> Function()? root}) : _root = root ?? getApplicationDocumentsDirectory;

  final Future<Directory> Function() _root;

  Future<Directory> _dir() async {
    final dir = Directory('${(await _root()).path}/offline_deliveries');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  Future<File> _index() async => File('${(await _dir()).path}/records.json');

  @override
  Future<List<OfflineDeliveryRecord>> load() async {
    final file = await _index();
    if (!await file.exists()) return const [];
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! List) return const [];
    return decoded.map(OfflineDeliveryRecord.fromJson).whereType<OfflineDeliveryRecord>().toList();
  }

  @override
  Future<void> save(List<OfflineDeliveryRecord> records) async {
    final file = await _index();
    // Write-then-rename, so a crash mid-write never leaves a half file.
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString(jsonEncode(records.map((r) => r.toJson()).toList()), flush: true);
    await tmp.rename(file.path);
  }

  Future<Directory> _photosFor(String orderId) async {
    // Document ids are [A-Za-z0-9]; anything else is replaced, never trusted as a path.
    final safe = orderId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
    final dir = Directory('${(await _dir()).path}/$safe');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  @override
  Future<String> keepPhoto(String orderId, String name, File photo) async {
    final dot = photo.path.lastIndexOf('.');
    final ext = dot >= 0 && photo.path.length - dot <= 5 ? photo.path.substring(dot) : '.jpg';
    final kept = await photo.copy('${(await _photosFor(orderId)).path}/$name$ext');
    return kept.path;
  }

  @override
  Future<void> deletePhotos(String orderId) async {
    final dir = await _photosFor(orderId);
    if (await dir.exists()) await dir.delete(recursive: true);
  }
}
