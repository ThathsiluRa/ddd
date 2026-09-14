import http from "http";
import { randomUUID } from "crypto";
import {
    CONTROL_API_ENABLED,
    CONTROL_API_HOST,
    CONTROL_API_PORT,
    CONTROL_API_TOKEN,
    MAX_PAIR_PER_USER,
} from "../setting/config.js";
import {
    addPairNumber,
    getAllPairs,
    getMode,
    getUsers,
    removePairNumber,
} from "../database.js";
import {
    endWhatsappForNumber,
    getClient,
    initWhatsappForNumber,
    waitForPairSuccess,
} from "./whatsapp.js";
import { log } from "./logger.js";
import { createFixedWindowRateLimiter, isAuthorized } from "./control-api-security.js";

const startedAt = Date.now();
const ANDROID_CONTROL_UID = "android-control";
let reconnectInProgress = false;
let lastReconnectAt = 0;

function sendJson(res, statusCode, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        ...extraHeaders,
    });
    res.end(payload);
}

async function readJsonBody(req, maximumBytes = 1024) {
    const chunks = [];
    let total = 0;

    for await (const chunk of req) {
        total += chunk.length;
        if (total > maximumBytes) {
            const error = new Error("Request body is too large.");
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    if (total === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        const error = new Error("Request body must be valid JSON.");
        error.statusCode = 400;
        throw error;
    }
}

function maskNumber(value) {
    const number = String(value).replace(/\D/g, "");
    if (number.length <= 4) return "••••";
    return `${"•".repeat(Math.min(8, number.length - 4))}${number.slice(-4)}`;
}

function sessionSnapshot() {
    const pairs = getAllPairs();
    const sessions = [];

    for (const [uid, numbers] of Object.entries(pairs)) {
        for (const number of Array.isArray(numbers) ? numbers : []) {
            const status = getClient(uid, number)?.status || "offline";
            sessions.push({ number: maskNumber(number), status });
        }
    }

    return {
        total: sessions.length,
        online: sessions.filter((item) => item.status === "open").length,
        connecting: sessions.filter((item) => item.status === "connecting").length,
        offline: sessions.filter((item) => !["open", "connecting"].includes(item.status)).length,
        sessions,
    };
}

async function reconnectDisconnected() {
    const pairs = getAllPairs();
    let attempted = 0;
    let skipped = 0;
    let failed = 0;

    for (const [uid, numbers] of Object.entries(pairs)) {
        for (const number of Array.isArray(numbers) ? numbers : []) {
            const current = getClient(uid, number);
            if (current?.status === "open" || current?.status === "connecting") {
                skipped += 1;
                continue;
            }

            attempted += 1;
            try {
                await initWhatsappForNumber(null, uid, number);
            } catch (error) {
                failed += 1;
                log.error(`Control API reconnect failed for ${maskNumber(number)}: ${error.message}`);
            }
        }
    }

    return { attempted, skipped, failed };
}

function numberAlreadySaved(number) {
    return Object.values(getAllPairs()).some(
        (numbers) => Array.isArray(numbers) && numbers.includes(number)
    );
}

async function requestPairingCode(rawNumber) {
    const number = String(rawNumber || "").replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(number)) {
        const error = new Error("Enter a phone number with country code and 8 to 15 digits.");
        error.statusCode = 400;
        throw error;
    }

    if (numberAlreadySaved(number)) {
        const error = new Error("That WhatsApp number is already saved.");
        error.statusCode = 409;
        throw error;
    }

    const ownedNumbers = getAllPairs()[ANDROID_CONTROL_UID] || [];
    if (ownedNumbers.length >= MAX_PAIR_PER_USER) {
        const error = new Error(`The maximum of ${MAX_PAIR_PER_USER} Android-managed numbers has been reached.`);
        error.statusCode = 409;
        throw error;
    }

    try {
        const socket = await initWhatsappForNumber(null, ANDROID_CONTROL_UID, number);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const code = await socket.requestPairingCode(number);
        addPairNumber(ANDROID_CONTROL_UID, number);

        waitForPairSuccess(ANDROID_CONTROL_UID, number, 120_000).catch(async (error) => {
            log.warning(`Pairing expired for ${maskNumber(number)}: ${error.message}`);
            removePairNumber(ANDROID_CONTROL_UID, number);
            await endWhatsappForNumber(ANDROID_CONTROL_UID, number);
        });

        return { code, number: maskNumber(number), expiresInSeconds: 120 };
    } catch (error) {
        removePairNumber(ANDROID_CONTROL_UID, number);
        await endWhatsappForNumber(ANDROID_CONTROL_UID, number);
        throw error;
    }
}

export async function startControlApi() {
    if (!CONTROL_API_ENABLED) {
        log.info("Android control API is disabled.");
        return null;
    }

    if (CONTROL_API_TOKEN.length < 32) {
        log.error("CONTROL_API_TOKEN must contain at least 32 characters. Control API was not started.");
        return null;
    }

    const generalLimit = createFixedWindowRateLimiter({ maxRequests: 60, windowMs: 60_000 });
    const pairingLimit = createFixedWindowRateLimiter({ maxRequests: 5, windowMs: 10 * 60_000 });

    const server = http.createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader("X-Request-Id", requestId);

        try {
            const remoteAddress = req.socket.remoteAddress || "unknown";
            const rate = generalLimit(remoteAddress);
            if (!rate.allowed) {
                req.resume();
                return sendJson(res, 429, { error: "Too many requests.", requestId }, {
                    "Retry-After": String(rate.retryAfterSeconds),
                });
            }

            if (!isAuthorized(req.headers.authorization, CONTROL_API_TOKEN)) {
                req.resume();
                return sendJson(res, 401, { error: "Unauthorized.", requestId }, {
                    "WWW-Authenticate": 'Bearer realm="SHOCO Control"',
                });
            }

            const url = new URL(req.url || "/", "http://localhost");

            if (req.method === "GET" && url.pathname === "/api/v1/health") {
                return sendJson(res, 200, {
                    ok: true,
                    service: "shoco-control",
                    serverTime: new Date().toISOString(),
                    requestId,
                });
            }

            if (req.method === "GET" && url.pathname === "/api/v1/status") {
                return sendJson(res, 200, {
                    service: "SHOCO Control API",
                    apiVersion: 1,
                    serverTime: new Date().toISOString(),
                    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
                    server: {
                        online: true,
                        runtime: process.version,
                    },
                    mode: getMode(),
                    legacyUsers: getUsers().length,
                    whatsapp: sessionSnapshot(),
                    capabilities: [
                        "status.read",
                        "sessions.pair",
                        "sessions.reconnectDisconnected",
                    ],
                    requestId,
                });
            }

            if (req.method === "POST" && url.pathname === "/api/v1/sessions/pair") {
                const pairRate = pairingLimit(remoteAddress);
                if (!pairRate.allowed) {
                    req.resume();
                    return sendJson(res, 429, { error: "Too many pairing attempts.", requestId }, {
                        "Retry-After": String(pairRate.retryAfterSeconds),
                    });
                }

                const body = await readJsonBody(req);
                const result = await requestPairingCode(body.number);
                return sendJson(res, 201, {
                    ok: true,
                    message: "Enter this code in WhatsApp Linked Devices.",
                    result,
                    requestId,
                });
            }

            if (req.method === "POST" && url.pathname === "/api/v1/actions/reconnect-disconnected") {
                req.resume();

                if (reconnectInProgress) {
                    return sendJson(res, 409, {
                        error: "A reconnect request is already running.",
                        requestId,
                    });
                }

                const cooldownRemaining = 30_000 - (Date.now() - lastReconnectAt);
                if (cooldownRemaining > 0) {
                    return sendJson(res, 429, {
                        error: "Reconnect is cooling down.",
                        requestId,
                    }, {
                        "Retry-After": String(Math.ceil(cooldownRemaining / 1000)),
                    });
                }

                reconnectInProgress = true;
                lastReconnectAt = Date.now();
                try {
                    const result = await reconnectDisconnected();
                    return sendJson(res, 202, {
                        ok: true,
                        message: "Reconnect requested for known disconnected sessions.",
                        result,
                        requestId,
                    });
                } finally {
                    reconnectInProgress = false;
                }
            }

            req.resume();
            return sendJson(res, 404, { error: "Not found.", requestId });
        } catch (error) {
            const statusCode = Number(error.statusCode) || 500;
            if (statusCode >= 500) {
                log.error(`Control API request ${requestId} failed: ${error.message}`);
            }
            if (!res.headersSent) {
                return sendJson(res, statusCode, {
                    error: statusCode >= 500 ? "Internal server error." : error.message,
                    requestId,
                });
            }
            res.end();
        }
    });

    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;

    return await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(CONTROL_API_PORT, CONTROL_API_HOST, () => {
            server.off("error", reject);
            server.on("error", (error) => log.error(`Control API server error: ${error.message}`));
            log.success(`Android control API listening on ${CONTROL_API_HOST}:${CONTROL_API_PORT}`);
            resolve(server);
        });
    });
}
