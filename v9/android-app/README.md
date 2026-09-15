# NAVIYA Control Android app

This is a native Android replacement for the former Telegram command menu. It
loads an authenticated menu catalog from the Node server and turns each allowed
action into a real Android button. It is not a Pterodactyl WebView.

## Working menu

- WhatsApp: refresh status, pair a number, reconnect known offline sessions.
- Tools: random quote, weather, and safe URL shortening.
- Public OSINT: RDAP domain registration, DNS records, IP information, and TLS
  certificate inspection.
- Code tools: JSON validation/formatting, code statistics, and function listing.

Each enabled button calls one explicit allowlisted API action and displays its
result in a selectable Android dialog. No arbitrary command string is executed.

Crash, freeze, flood, forced-close, ban, broadcast, disruptive WhatsApp payload,
website-cloning, and arbitrary-code execution actions are not included.

## Server deployment

Update `path/control-api.js` on Pterodactyl from this branch and restart the
Node service. Keep the existing `.env` token and API port configuration.

The Android app requires the API to be served from a valid HTTPS hostname. Enter
that HTTPS origin and the exact `CONTROL_API_TOKEN`, then tap **Save & Connect**.

## APK

Download the newest `shoco-control-debug-apk` artifact from the **Android
companion APK** workflow. Uninstall an older debug APK first if Android reports
a signing conflict.
