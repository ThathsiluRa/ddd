# SHOCO Android bot control

This Node service is controlled by the native NAVIYA Control Android app. It does
not require Telegram or expose Telegram commands.

## Pterodactyl

Use Node.js 22 and place the contents of `v9` directly in `/home/container`.
Create `/home/container/.env`:

```env
CONTROL_API_ENABLED=true
CONTROL_API_HOST=0.0.0.0
CONTROL_API_PORT=2052
CONTROL_API_TOKEN=replace_with_a_unique_secret_of_at_least_32_characters
MAX_PAIR_PER_USER=5
SESSION_ROOT=./sessions
```

Use the actual allocated port if it differs. Publish the API behind a valid
HTTPS hostname before connecting the APK.

## Native app menus

The server publishes an authenticated safe-menu catalog consumed by the APK:

- WhatsApp pairing, status, and reconnect controls;
- quote, weather, and link tools;
- public domain, DNS, IP, and TLS information;
- JSON and non-executing code inspection tools.

Every action is explicitly allowlisted. Crash, freeze, flood, forced-close, ban,
broadcast, disruptive payload, arbitrary command, and arbitrary code execution
features are absent.

See `android-app/README.md` for the APK workflow and usage.
