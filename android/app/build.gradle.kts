import java.util.Properties
import org.gradle.api.Action
import org.gradle.api.execution.TaskExecutionGraph

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Release credentials are deliberately external to the repository.  A local
 * `android/credentials/release-keystore.properties` is convenient for the
 * owner; CI receives the same values through environment variables.
 */
val releaseKeystoreProperties = Properties().apply {
    val localFile = rootProject.file("credentials/release-keystore.properties")
    if (localFile.isFile) {
        localFile.inputStream().use(::load)
    }
}

fun releaseCredential(property: String, environment: String): String? =
    providers.gradleProperty(property).orNull
        ?: providers.environmentVariable(environment).orNull
        ?: releaseKeystoreProperties.getProperty(property)

val releaseStoreFile = releaseCredential("storeFile", "LAMASYNC_ANDROID_KEYSTORE_PATH")
val releaseStorePassword = releaseCredential("storePassword", "LAMASYNC_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = releaseCredential("keyAlias", "LAMASYNC_ANDROID_KEY_ALIAS")
val releaseKeyPassword = releaseCredential("keyPassword", "LAMASYNC_ANDROID_KEY_PASSWORD")
val releaseSigningReady = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

fun androidVersionCode(versionName: String): Int {
    val parts = versionName.split(".")
    require(parts.size == 3 && parts.all { it.toIntOrNull() != null }) {
        "lamasyncVersionName must be a stable MAJOR.MINOR.PATCH version, got '$versionName'."
    }
    val (major, minor, patch) = parts.map(String::toInt)
    require(major in 0..999 && minor in 0..999 && patch in 0..999) {
        "Each lamasyncVersionName component must be between 0 and 999."
    }
    return major * 1_000_000 + minor * 1_000 + patch
}

val rootPackageVersion = Regex("\\\"version\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
    .find(rootProject.file("../package.json").readText())
    ?.groupValues
    ?.get(1)
    ?: error("Could not read the root package version for the Android build.")
val lamasyncVersionName = providers.gradleProperty("lamasyncVersionName").orElse(rootPackageVersion).get()

android {
    namespace = "app.lamasync.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.lamasync.companion"
        // Stable once chosen (spec): app.lamasync.companion.
        minSdk = 26
        targetSdk = 35
        // Keep Android's installed version in lockstep with the GitHub release
        // tag.  The numeric form is monotonically increasing for semver tags.
        versionCode = androidVersionCode(lamasyncVersionName)
        versionName = lamasyncVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            if (releaseSigningReady) {
                storeFile = rootProject.file(requireNotNull(releaseStoreFile))
                storePassword = requireNotNull(releaseStorePassword)
                keyAlias = requireNotNull(releaseKeyAlias)
                keyPassword = requireNotNull(releaseKeyPassword)
            }
        }
    }

    buildTypes {
        release {
            // Distribution is a signed GitHub Release APK. Credentials must
            // come from the ignored local properties file or CI environment.
            isMinifyEnabled = false
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    lint {
        abortOnError = true
        checkReleaseBuilds = true
        // The WebView is deliberately configured per-screen with explicit
        // hardening; see web/HardenedWebView.kt and WebViewNavigationPolicy.
        disable += "SetJavaScriptEnabled"
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = false
            isReturnDefaultValues = false
            // LAMA-329: PaletteMirrorsWebTokensTest reads the web UI's
            // design-token contract (packages/web-ui/src/index.css) to detect
            // palette drift. Resolved from the Gradle root project rather than
            // the test's working directory, which AGP does not guarantee.
            all {
                it.systemProperty(
                    "lamasync.webUiCss",
                    rootProject.file("../packages/web-ui/src/index.css").absolutePath,
                )
            }
        }
    }
}

gradle.taskGraph.whenReady(object : Action<TaskExecutionGraph> {
    override fun execute(graph: TaskExecutionGraph) {
        val requestsRelease = graph.allTasks.any { task ->
            task.name.contains("release", ignoreCase = true) &&
                (task.name.startsWith("assemble", ignoreCase = true) ||
                    task.name.startsWith("package", ignoreCase = true))
        }
        check(!requestsRelease || releaseSigningReady) {
            "A release APK requires signing credentials. See docs/android-release.md."
        }
    }
})

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.swipe.refresh.layout)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.work.runtime.ktx)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
