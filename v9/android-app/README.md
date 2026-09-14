# SHOCO Control Android app

This native Kotlin app is a deliberately small companion for the Node bot in `v9`.
It reads bot/session status and can request reconnection of sessions already stored by
the bot. It does not expose arbitrary Telegram or WhatsApp commands.

## Build an APK

Open this repository's **Actions** tab, run **Android companion APK**, then download
the `shoco-control-debug-apk` artifact. The workflow uses JDK 17, Gradle 8.9, and
Android Gradle Plugin 8.7.3.

To build locally with Gradle 8.9:

```bash
cd v9/android-app
gradle :app:assembleDebug
```

The APK is written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Connect it to Pterodactyl

1. Generate a unique token. For example: `openssl rand -hex 32`.
2. Add a Pterodactyl allocation for the API port.
3. Configure these server variables:

   ```text
   CONTROL_API_ENABLED=true
   CONTROL_API_HOST=0.0.0.0
   CONTROL_API_PORT=3000
   CONTROL_API_TOKEN=<your generated token>
   ```

4. Route that allocation through a domain with a valid HTTPS certificate.
5. In the app, enter the HTTPS origin (for example
   `https://control.example.com`) and the same token.

Do not put the token in GitHub, the APK, screenshots, or chat messages. The app
encrypts the saved token with Android Keystore and refuses cleartext HTTP. A
self-signed certificate will not be accepted by a normal Android installation.

## API surface

Every route requires `Authorization: Bearer <token>`.

- `GET /api/v1/health` — authenticated liveness check.
- `GET /api/v1/status` — Telegram state and non-secret aggregate statistics.
- `POST /api/v1/actions/reconnect-disconnected` — reconnects known saved
  sessions only, with a cooldown and concurrent-run lock.

There is no generic command executor, message-sending route, session deletion
route, or crash/flood/disruption feature.
