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
CONTROL_MENU_FILE=./control-menu.json
```

Use the actual allocated port if it differs. Publish the API behind a valid
HTTPS hostname before connecting the APK.

## Pterodactyl-controlled native menus

The APK downloads `control-menu.json` through the authenticated API. Edit this
file in the Pterodactyl file manager to change categories, button titles,
descriptions, ordering, input types, input hints, multiline fields, and
confirmations. Save the file and refresh the app; menu-only changes are loaded
without rebuilding the APK or restarting Node.

Each menu item maps to an explicit allowlisted action in
`path/control-api.js`. Unknown IDs are ignored, and the configuration cannot
execute shell commands or inject JavaScript. To add genuinely new behavior,
implement and allowlist its handler, restart Node, then add its button to
`control-menu.json`.

Included actions cover WhatsApp session management, everyday utilities, text
transformations, public OSINT, JSON tools, and non-executing code inspection.

Crash, freeze, flood, forced-close, ban, broadcast, disruptive payload,
arbitrary-command, and arbitrary-code execution features are absent.

See `android-app/README.md` for the APK workflow and usage.
