import 'dart:io';

import 'package:firebase_storage/firebase_storage.dart';
import 'package:image_picker/image_picker.dart';

import '../utils/proof_validation.dart';

/// A stored evidence object: where it lives and how to fetch it.
///
/// The uploader used to return the download URL alone, so the caller had no way
/// to record WHICH object the URL referred to. Without the path, nothing
/// downstream — not the Firestore write, not the rules — could check that the
/// URL belonged to this order's canonical object rather than some other one.
class EvidenceUpload {
  const EvidenceUpload({required this.downloadUrl, required this.storagePath});

  final String downloadUrl;

  /// Full Storage path, e.g. `proof_of_delivery/{orderId}/proof.jpg`.
  final String storagePath;
}

/// What the proof screen needs from Storage. Named separately from the concrete
/// implementation so the submission controller can be driven by a fake in tests
/// without a Firebase connection.
abstract class ProofUploader {
  Future<EvidenceUpload> uploadProof(String orderId, File file);
  Future<EvidenceUpload> uploadInvoice(String orderId, File file);

  /// The download URL of an order's canonical proof object, or null when no
  /// such object exists.
  Future<String?> existingProofUrl(String orderId);
}

class ImageUploadService implements ProofUploader {
  ImageUploadService({FirebaseStorage? storage, ImagePicker? picker})
      : _storage = storage ?? FirebaseStorage.instance,
        _picker = picker ?? ImagePicker();

  final FirebaseStorage _storage;
  final ImagePicker _picker;

  Future<XFile?> pickFromCamera() {
    return _picker.pickImage(source: ImageSource.camera, imageQuality: 80);
  }

  Future<XFile?> pickFromGallery() {
    return _picker.pickImage(source: ImageSource.gallery, imageQuality: 80);
  }

  @override
  Future<EvidenceUpload> uploadProof(String orderId, File file) {
    return _upload(proofObjectPath(orderId), file);
  }

  @override
  Future<EvidenceUpload> uploadInvoice(String orderId, File file) {
    return _upload(invoiceObjectPath(orderId), file);
  }

  /// Upload to one deterministic path.
  ///
  /// The size is read from the file and checked BEFORE the request starts, so
  /// an oversized photo costs a stat call rather than a long upload that the
  /// rules then refuse. The content type is set explicitly: Storage rules
  /// require `image/*`, and an object uploaded without one is refused.
  Future<EvidenceUpload> _upload(String path, File file) async {
    final size = await file.length();
    final sizeCheck = validateEvidenceSize(size);
    if (!sizeCheck.valid) {
      throw ProofException(sizeCheck.code!, sizeCheck.message!);
    }

    final ref = _storage.ref(path);
    await ref.putFile(
      file,
      SettableMetadata(contentType: imageContentTypeFor(file.path)),
    );
    // Same ref, immediately after the upload. The assigned rider is granted
    // read on their own order's evidence precisely so this second call can
    // succeed; without it the object would be stored with no URL recorded.
    final url = await ref.getDownloadURL();
    return EvidenceUpload(downloadUrl: url, storagePath: path);
  }

  /// Recover an upload that completed but whose Firestore write did not.
  ///
  /// Because the object name is deterministic, a submission that failed after
  /// the upload leaves the photo at a known path. Reopening the screen can find
  /// it and finish saving the metadata instead of uploading a second copy.
  ///
  /// `object-not-found` is the ordinary "nothing pending, upload normally" case
  /// and is reported as null. Every other Storage error — permission, network,
  /// quota — is rethrown, because silently treating those as "no object" would
  /// hide a real fault and create the duplicate this method exists to avoid.
  @override
  Future<String?> existingProofUrl(String orderId) async {
    try {
      return await _storage.ref(proofObjectPath(orderId)).getDownloadURL();
    } on FirebaseException catch (e) {
      if (e.code == 'object-not-found') return null;
      rethrow;
    }
  }
}
