# Pterodactyl Panel Android wrapper

The Android app is a focused WebView wrapper for:

```text
https://panel.srilankangrill.online
```

It uses the panel's normal login page and cookies. No API URL or bot-control token
is required inside the app.

## Included behavior

- JavaScript and DOM storage required by Pterodactyl;
- persistent login cookies;
- file chooser support for panel uploads;
- authenticated panel downloads through Android Download Manager;
- back navigation, reload, loading progress, and browser fallback;
- HTTPS-only networking and fail-closed certificate validation;
- external domains open in the device browser.

## Install

Open the repository's **Android companion APK** workflow, download the newest
`shoco-control-debug-apk` artifact, extract it, and install `app-debug.apk`.

Because GitHub debug builds may use a different signing key, uninstall the older
SHOCO Control APK before installing this WebView build.
