plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "net.ridesharemedia.shell"
    compileSdk = 35

    defaultConfig {
        applicationId = "net.ridesharemedia.shell"
        minSdk = 28            // Android 9: lock task features, Keystore P-256, WebView updates via Play
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // Default server; production fleets set server_url through managed configuration (EMM).
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://rides.example.invalid\"")
        buildConfigField("boolean", "ALLOW_CLEARTEXT_SERVER", "false")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            // Emulator/dev only: http://10.0.2.2:8080 reaches the developer's machine.
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:8080\"")
            buildConfigField("boolean", "ALLOW_CLEARTEXT_SERVER", "true")
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = true
    }
    testOptions { unitTests.isReturnDefaultValues = false }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // real org.json on the JVM (android.jar only has stubs)
}
