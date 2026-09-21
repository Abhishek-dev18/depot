import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

/**
 * Signing material, from a file locally or from the environment in CI.
 *
 * keystore.properties is gitignored and the keystore itself never goes
 * near the repository. When neither is present the release build is
 * simply unsigned, so anyone can run `assembleRelease` to check that the
 * shrinker has not broken anything without first being handed a key.
 *
 * Generating one, once, and keeping it somewhere you will still have it
 * in two years — losing it means never being able to update an installed
 * app again:
 *
 *   keytool -genkeypair -v -keystore depot-release.jks \
 *     -keyalg RSA -keysize 4096 -validity 10000 -alias depot
 */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingValue(key: String, env: String): String? =
    keystoreProperties.getProperty(key) ?: System.getenv(env)

val releaseStoreFile: String? = signingValue("storeFile", "DEPOT_KEYSTORE_FILE")
val releaseStorePassword: String? = signingValue("storePassword", "DEPOT_KEYSTORE_PASSWORD")
val releaseKeyAlias: String? = signingValue("keyAlias", "DEPOT_KEY_ALIAS")
val releaseKeyPassword: String? = signingValue("keyPassword", "DEPOT_KEY_PASSWORD")
val canSignRelease = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "com.depot.app"
    compileSdk {
        version = release(35)
    }

    defaultConfig {
        applicationId = "com.depot.app"
        minSdk = 26
        targetSdk = 35
        // Overridable from CI so a tagged build carries its own version
        // rather than every release calling itself 1.0.
        versionCode = (System.getenv("DEPOT_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("DEPOT_VERSION_NAME") ?: "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                // v1 is for API < 24 and this app is minSdk 26, so the
                // modern schemes are the only ones that need to be on.
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
            signingConfig = if (canSignRelease) signingConfigs.getByName("release") else null
            // A release build that reports itself as debuggable would let
            // anything on the device read this app's private storage,
            // which is where the Depot identity key lives.
            isDebuggable = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
    }

    sourceSets.getByName("androidTest") {
        // docs/vectors holds the known-answer vectors shared with web/.
        // Pointing at the directory rather than copying keeps one source of
        // truth, so the two implementations cannot silently drift apart.
        assets.srcDir(rootProject.file("../docs/vectors"))
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.lazysodium.android) {
        // lazysodium's POM declares jna with no classifier, which resolves
        // to the .jar. Android needs the .aar below — it is the one that
        // carries the native libraries — and having both on the classpath
        // duplicates every com.sun.jna class.
        exclude(group = "net.java.dev.jna", module = "jna")
    }
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.stream.webrtc.android)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    // Bundled rather than the Play Services variant: it keeps QR scanning
    // working on a device without Google Play, which matters for a tool
    // whose point is not depending on anyone's infrastructure.
    implementation(libs.mlkit.barcode.scanning)
    // JNA must be the .aar variant on Android — the .jar ships no native
    // libraries. A version catalog cannot express the @aar classifier, so
    // this one stays literal.
    implementation("net.java.dev.jna:jna:${libs.versions.jna.get()}@aar")
    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}