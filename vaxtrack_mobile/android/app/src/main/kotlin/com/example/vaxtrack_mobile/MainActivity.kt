package com.example.vaxtrack_mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Adds ONE platform channel: the Android 13+ notification permission that makes
 * the delivery-location foreground-service notification visible
 * (lib/services/rider_tracking_service.dart NotificationPermission). It is
 * requested only after the rider agreed to share location for a delivery.
 */
class MainActivity : FlutterActivity() {
    private val channelName = "vaxtrack/notification_permission"
    private val requestCode = 4107
    private var pending: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "status" -> result.success(if (granted()) "granted" else "denied")
                    "request" -> {
                        if (granted()) {
                            result.success("granted")
                        } else if (pending != null) {
                            result.error("busy", "A permission request is already in progress", null)
                        } else {
                            pending = result
                            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), requestCode)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun granted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == requestCode) {
            val ok = results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED
            pending?.success(if (ok) "granted" else "denied")
            pending = null
        }
    }
}
