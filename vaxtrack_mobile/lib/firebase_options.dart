import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      default:
        return android;
    }
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyCVRckmGWwBP9ts9uMWK4IQ4dFK-OSWut4',
    appId: '1:1023801727166:android:109c0158307151f5b166ef',
    messagingSenderId: '1023801727166',
    projectId: 'vaxtrack-bef1b',
    storageBucket: 'vaxtrack-bef1b.firebasestorage.app',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyCVRckmGWwBP9ts9uMWK4IQ4dFK-OSWut4',
    appId: '1:1023801727166:ios:REPLACE_WITH_IOS_APP_ID',
    messagingSenderId: '1023801727166',
    projectId: 'vaxtrack-bef1b',
    storageBucket: 'vaxtrack-bef1b.firebasestorage.app',
    iosBundleId: 'com.example.vaxtrackMobile',
  );
}
