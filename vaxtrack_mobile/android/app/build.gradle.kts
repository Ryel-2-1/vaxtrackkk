import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
}

// Google Navigation SDK feasibility spike: read the Android Maps/Navigation key
// from the git-ignored local.properties and inject it as a manifest placeholder.
// The key is NEVER hardcoded in Gradle/XML/Dart — only referenced from the
// ignored file at build time.
val localProperties = Properties()
val localPropertiesFile = rootProject.file("local.properties")
if (localPropertiesFile.exists()) {
    localPropertiesFile.inputStream().use { localProperties.load(it) }
}
val mapsApiKey: String = localProperties.getProperty("MAPS_API_KEY") ?: ""

// Release signing configuration, loaded from the git-ignored android/key.properties.
// The alias/passwords/keystore path are NEVER hardcoded or logged here — they are
// only referenced via getProperty() at build time.
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

android {
    namespace = "com.example.vaxtrack_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // Officially required by google_navigation_flutter
        // (com.google.android.libraries.navigation) — see checkDebugAarMetadata.
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.example.vaxtrack_mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion // already 24; meets Navigation SDK requirement
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // Navigation SDK API key injected from local.properties (spike only).
        manifestPlaceholders["MAPS_API_KEY"] = mapsApiKey
    }

    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties.getProperty("keyAlias")
            keyPassword = keystoreProperties.getProperty("keyPassword")
            storeFile = keystoreProperties.getProperty("storeFile")?.let { file(it) }
            storePassword = keystoreProperties.getProperty("storePassword")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    // Environment flavors: production (vaxtrack-bef1b) vs staging (vaxtrack-staging).
    // The com.google.gms.google-services plugin selects the matching
    // google-services.json per flavor at build time:
    //   production → android/app/google-services.json              (vaxtrack-bef1b)
    //   staging    → android/app/src/staging/google-services.json  (vaxtrack-staging)
    // Staging gets a distinct applicationId (via suffix) and a visibly different
    // app name so it installs side-by-side with production and is never mistaken
    // for it. No Firebase secrets live in Gradle — only the JSON files (ignored).
    flavorDimensions += "environment"

    productFlavors {
        create("production") {
            dimension = "environment"
            // Uses defaultConfig.applicationId = com.example.vaxtrack_mobile.
            resValue("string", "app_name", "VaxTrack Rider")
        }
        create("staging") {
            dimension = "environment"
            // → com.example.vaxtrack_mobile.staging
            applicationIdSuffix = ".staging"
            resValue("string", "app_name", "VaxTrack Rider (Staging)")
        }
    }
}

dependencies {
    // Required by the Navigation SDK (checkDebugAarMetadata): the NIO desugar
    // flavor specifically (java.nio support), version >= 2.1.5.
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.1.5")
}

flutter {
    source = "../.."
}
