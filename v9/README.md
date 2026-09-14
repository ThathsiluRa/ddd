# SHOCO Telegram / WhatsApp Bot — Pterodactyl Edition

This is a standalone Node.js bot package prepared for a Pterodactyl Node.js egg.
The existing `travas.js` file is preserved unchanged. Dependencies are downloaded
from npm without requiring GitHub access.

## Requirements

- Node.js 20 or newer (Node.js 20 or 22 is recommended)
- A Telegram bot token from BotFather
- The owner’s numeric Telegram user ID

## Install on Pterodactyl

1. Create a server using a Node.js 20+ egg.
2. Upload this archive and extract it into the server’s root directory.
3. In the server console, run:

   ```bash
   npm install --omit=dev
   ```

4. Add these variables in the Pterodactyl Startup or Variables panel:

   - `BOT_TOKEN` — required Telegram bot token
   - `OWNER_ID` — required numeric Telegram user ID

   Optional variables are listed in `.env.example`.

For force-join checks, use one of these formats for each configured target:

```text
@public_channel_username
-1001234567890
https://t.me/public_channel_username
```

The bot must be an administrator in every configured group or channel so
Telegram allows it to call `getChatMember`. Private invite links can be shown
as join buttons, but they cannot be used for membership verification; use the
numeric chat ID for verification and provide a public username when possible.

## Global trial

An owner or admin can temporarily enable premium access for every user:

```text
/trial 24
```

The number is the duration in hours. The trial is saved in
`database/trial.json` and expires automatically. To stop it early, use:

```text
/trial off
```

5. Set the server startup command to:

   ```bash
   npm start
   ```

   If the egg does not preserve installed packages after reinstalling, use:

   ```bash
   npm install --omit=dev && npm start
   ```

6. Start the server. A successful startup includes messages similar to:

   ```text
   SHOYU BOT (utama) berhasil terhubung ke Telegram
   SHOYU BOT siap digunakan
   ```

## If Telegram returns `401 Unauthorized`

This response comes from Telegram, not Pterodactyl. It means the value in
`BOT_TOKEN` is not accepted by Telegram. In BotFather, use `/token` for the
correct bot and copy the newly generated token. In Pterodactyl, create a
variable named `BOT_TOKEN` and put only the raw token in its value:

```text
Name:  BOT_TOKEN
Value: 123456789:AAExampleToken
```

For a `.env` file, use `BOT_TOKEN=123456789:AAExampleToken` instead. Do not
include `BOT_TOKEN=` in the Pterodactyl value, use a second bot's token, or add
spaces around the value. If the token was exposed publicly, revoke it in
BotFather and generate a replacement. This build validates the token with
Telegram before starting WhatsApp restore or the update runner, so an invalid
token now exits with a direct error message.

If you are replacing an older upload that already has a partial install, stop the
server first and run this once from the server console:

```bash
rm -rf node_modules package-lock.json
npm install --omit=dev
```

After that, the normal startup command is just `npm start`.

## Using a `.env` file instead

Copy `.env.example` to `.env`, fill in the values, and keep the file private. Do not upload or share `.env` publicly.

## Persistent data

- `database/` contains bot data.
- `sessions/` is created automatically for WhatsApp authentication sessions.

Back up both folders before reinstalling or changing servers.

## Android companion control

The optional native Android client lives in `android-app/`. It connects to a
small authenticated API in this Node process. Set `CONTROL_API_ENABLED=true`,
configure a unique 32+ character `CONTROL_API_TOKEN`, assign
`CONTROL_API_PORT` in Pterodactyl, and publish the port behind valid HTTPS.

The app intentionally supports only status viewing and reconnecting known
disconnected sessions. Full numbers are masked, tokens are never returned, and
legacy crash, flood, mass-message, destructive, and arbitrary-command features
are not available through the API. See `android-app/README.md` for build and
connection instructions.

Run the security helper tests with:

```bash
npm test
```

## Important changes in this fixed build

- Uses the published `baileys` package instead of the unavailable original dependency path.
- Removes unused packages that could not be installed from the registry.
- Handles empty optional menu media without crashing.
- Unsafe WhatsApp mass-messaging/crash payload actions are disabled.
- Adds an opt-in authenticated, rate-limited Android companion API.
