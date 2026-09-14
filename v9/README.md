# SHOCO Android WhatsApp Control

This build runs as a standalone Node.js WhatsApp-session service controlled by
the native Android app. It does not start Telegram, require a Telegram bot token,
or register Telegram commands.

Crash, flood, forced-close, ban, disruptive-payload, arbitrary-command, and
mass-message functionality is not included.

## Pterodactyl installation

Use Node.js 22. Place these files directly in `/home/container`, so
`/home/container/package.json` and `/home/container/index.js` exist.

Create `/home/container/.env`:

```env
CONTROL_API_ENABLED=true
CONTROL_API_HOST=0.0.0.0
CONTROL_API_PORT=3000
CONTROL_API_TOKEN=replace_with_a_unique_secret_of_at_least_32_characters

MAX_PAIR_PER_USER=5
SESSION_ROOT=./sessions
```

Set `CONTROL_API_PORT` to a port allocated to the server. Put the allocation
behind a domain with a valid HTTPS certificate because the Android app refuses
cleartext HTTP.

Set the Pterodactyl startup command variable to:

```text
npm start
```

On a clean installation:

```bash
npm install
npm start
```

## Android app

Download the APK from the **Android companion APK** workflow artifact. In the
app, save the HTTPS server origin and the same `CONTROL_API_TOKEN`.

The app can:

- read server and WhatsApp session status;
- request a WhatsApp pairing code for a phone number with country code;
- reconnect known disconnected sessions.

For pairing, enter the number in the app, tap **Get pairing code**, then in
WhatsApp open **Linked devices → Link a device → Link with phone number** and
enter the displayed code within two minutes.

## Authenticated API

Every endpoint requires `Authorization: Bearer <token>`.

- `GET /api/v1/health`
- `GET /api/v1/status`
- `POST /api/v1/sessions/pair`
- `POST /api/v1/actions/reconnect-disconnected`

The server applies request limits, pairing attempt limits, a reconnect cooldown,
masked phone-number responses, bounded JSON bodies, and fail-closed token checks.
