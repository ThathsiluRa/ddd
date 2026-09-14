import { log } from "./path/logger.js";
import { loadAllWhatsappSessions } from "./path/whatsapp.js";
import { startControlApi } from "./path/control-api.js";

// The Android companion is the primary control surface. Telegram credentials
// are not required and no Telegram polling process is started.
await loadAllWhatsappSessions(null);

let controlServer = null;
try {
    controlServer = await startControlApi();
} catch (error) {
    log.error(`Android control API could not start: ${error.message}`);
}

if (!controlServer) {
    log.error(
        "The Android control API is not running. Set CONTROL_API_TOKEN to a " +
        "unique value with at least 32 characters and ensure CONTROL_API_ENABLED is not false."
    );
    process.exitCode = 1;
    process.exit();
}

log.whatsapp("SHOCO Android control server is ready 🚀");

const stopServices = () => {
    if (controlServer?.listening) controlServer.close();
};
process.once("SIGINT", stopServices);
process.once("SIGTERM", stopServices);
