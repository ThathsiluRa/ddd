import "dotenv/config";

function cleanEnv(value) {
  return String(value ?? "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
}

// Legacy values stay optional so old session folders and handler modules remain
// compatible, but the Android-only server never requires Telegram credentials.
export const BOT_TOKEN = cleanEnv(process.env.BOT_TOKEN);
export const OWNER_ID = cleanEnv(process.env.OWNER_ID);
export const OWNER_USERNAME = cleanEnv(process.env.OWNER_USERNAME);
export const OWNER_NUMBER = cleanEnv(process.env.OWNER_NUMBER);
export const ADMIN_GROUP_JID = cleanEnv(process.env.ADMIN_GROUP_JID);

export const MENU_PHOTO_URL = cleanEnv(process.env.MENU_PHOTO_URL);
export const MENU_VIDEO_URL = cleanEnv(process.env.MENU_VIDEO_URL);
export const FORCE_JOIN_CHANNEL = cleanEnv(process.env.FORCE_JOIN_CHANNEL);
export const FORCE_JOIN_CHANNEL2 = cleanEnv(process.env.FORCE_JOIN_CHANNEL2);
export const FORCE_JOIN_CHANNEL3 = cleanEnv(process.env.FORCE_JOIN_CHANNEL3);
export const FORCE_JOIN_CHANNEL4 = cleanEnv(process.env.FORCE_JOIN_CHANNEL4);
export const FORCE_JOIN_CHANNEL5 = cleanEnv(process.env.FORCE_JOIN_CHANNEL5);

export const MAX_PAIR_PER_USER = parseInt(process.env.MAX_PAIR_PER_USER, 10) || 5;
export const SESSION_ROOT = cleanEnv(process.env.SESSION_ROOT) || "./sessions";

// Enabled by default, but startControlApi still fails closed unless a strong
// bearer token is configured.
export const CONTROL_API_ENABLED =
  cleanEnv(process.env.CONTROL_API_ENABLED).toLowerCase() !== "false";
export const CONTROL_API_TOKEN = cleanEnv(process.env.CONTROL_API_TOKEN);
export const CONTROL_API_HOST = cleanEnv(process.env.CONTROL_API_HOST) || "0.0.0.0";
export const CONTROL_API_PORT = parseInt(process.env.CONTROL_API_PORT, 10) || 3000;
