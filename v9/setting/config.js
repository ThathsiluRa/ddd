import 'dotenv/config';

// Deobfuscated / sanitized config
function cleanEnv(value) {
  return String(value ?? '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

export const BOT_TOKEN = cleanEnv(process.env.BOT_TOKEN);
export const OWNER_ID = cleanEnv(process.env.OWNER_ID);
export const OWNER_USERNAME = cleanEnv(process.env.OWNER_USERNAME);
export const OWNER_NUMBER = cleanEnv(process.env.OWNER_NUMBER);   // <-- New
export const ADMIN_GROUP_JID = cleanEnv(process.env.ADMIN_GROUP_JID); // <-- New

export const MENU_PHOTO_URL = cleanEnv(process.env.MENU_PHOTO_URL);
export const MENU_VIDEO_URL = cleanEnv(process.env.MENU_VIDEO_URL);

export const FORCE_JOIN_CHANNEL = cleanEnv(process.env.FORCE_JOIN_CHANNEL);
export const FORCE_JOIN_CHANNEL2 = cleanEnv(process.env.FORCE_JOIN_CHANNEL2);
export const FORCE_JOIN_CHANNEL3 = cleanEnv(process.env.FORCE_JOIN_CHANNEL3);
export const FORCE_JOIN_CHANNEL4 = cleanEnv(process.env.FORCE_JOIN_CHANNEL4);
export const FORCE_JOIN_CHANNEL5 = cleanEnv(process.env.FORCE_JOIN_CHANNEL5);

// Numeric / computed values (can be overridden via .env)
export const MAX_PAIR_PER_USER = parseInt(process.env.MAX_PAIR_PER_USER) || 5;
export const SESSION_ROOT = cleanEnv(process.env.SESSION_ROOT) || './sessions';

// Fail fast if required env vars are missing
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Add the raw token from @BotFather to the Pterodactyl variable BOT_TOKEN.');
  process.exit(1);
}
if (!/^\d+:[A-Za-z0-9_-]+$/.test(BOT_TOKEN)) {
  console.error('BOT_TOKEN format is invalid. Do not include BOT_TOKEN=, quotes, or extra spaces.');
  process.exit(1);
}
if (!OWNER_ID) {
  console.error('OWNER_ID is missing. Add your numeric Telegram user ID to the Pterodactyl variable OWNER_ID.');
  process.exit(1);
}
if (!OWNER_NUMBER) {
  console.warn('OWNER_NUMBER is missing. Admin report via owner socket will not work.');
}