plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.shoco.control"; compileSdk = 35
    defaultConfig { applicationId = "com.shoco.control"; minSdk = 26; targetSdk = 35; versionCode = 5; versionName = "4.1.0" }
    buildTypes { release { isMinifyEnabled = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro") } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
