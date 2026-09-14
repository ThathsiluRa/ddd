# SHOCO Control Android app

This native Kotlin app is the control surface for the Node service in `v9`.
Telegram is not used or required.

## Build an APK

Open the repository's **Actions** tab, run **Android companion APK**, then
download the `shoco-control-debug-apk` artifact.

To build locally with Gradle 8.9:

```bash
cd v9/android-app
gradle :app:assembleDebug
```

## Connect to Pterodactyl

Configure the Node server:

```text
CONTROL_API_ENABLED=true
CONTROL_API_HOST=0.0.0.0
CONTROL_API_PORT=3000
CONTROL_API_TOKEN=<unique secret containing at least 32 characters>
```

Route the allocated port through a domain with a valid HTTPS certificate. In the
app, enter the HTTPS origin and the same token, then tap **Save & Connect**.

To pair WhatsApp, enter the phone number with country code, request a pairing
code, then open WhatsApp **Linked devices → Link a device → Link with phone
number** and enter the code.

The saved API token is encrypted with Android Keystore. The app and API do not
provide crash, flood, ban, arbitrary-command, destructive, or mass-message
features.
