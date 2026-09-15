# NAVIYA Control Android app

NAVIYA Control is a native, server-driven replacement for the former Telegram
command menu. It is not a WebView and it does not keep a fixed command list in
the APK.

## Server-driven controls

On every refresh the app downloads `GET /api/v1/menu`. The response controls:

- the app title and subtitle;
- category names, descriptions, order, and visibility;
- button names, descriptions, and order;
- whether input is required;
- input type, hint, and multiline behavior;
- optional confirmation text;
- the allowlisted server action ID.

Select a category in the app to open its controls. All configurable actions use
the authenticated `POST /api/v1/actions/run` endpoint.

Edit `/home/container/control-menu.json` in Pterodactyl, save it, and refresh
the app. Menu-only edits do not need an APK rebuild or server restart.

Unknown action IDs are omitted. Adding new behavior still requires a reviewed,
allowlisted handler in `path/control-api.js` and a Node restart. JSON cannot
inject shell commands or JavaScript.

## Included safe controls

- WhatsApp status, pairing, and reconnect.
- Weather, quotes, URL shortening, timestamps, UUIDs, and password generation.
- Text statistics, case conversion, Base64, URL encoding, and SHA-256.
- Public RDAP, DNS, reverse DNS, IP, and TLS inspection.
- JSON validation/formatting and non-executing code inspection.

Crash, freeze, flood, forced-close, ban, broadcast, disruptive WhatsApp payload,
website-cloning, arbitrary-command, and arbitrary-code execution actions are
not included.

## Deployment

Copy both `control-menu.json` and `path/control-api.js` from this branch into
the Pterodactyl server, keeping the same relative paths, then restart Node.

The production API URL is preconfigured as
`https://bot.srilankangrill.online`. Enter `CONTROL_API_TOKEN` once; Android
stores it using encrypted preferences and reconnects automatically.

## APK

Download the newest `shoco-control-debug-apk` artifact from the **Android
companion APK** workflow. Uninstall an older debug APK first if Android reports
a signing conflict.
