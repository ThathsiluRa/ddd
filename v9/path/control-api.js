import http from "http";
import { randomUUID } from "crypto";
import {
    CONTROL_API_ENABLED,
    CONTROL_API_HOST,
    CONTROL_API_PORT,
    CONTROL_API_TOKEN,
} from "../setting/config.js";
import { getAllPairs, getMode, getUsers } from "../database.js";
import { deployedBots } from "./deploy.js";
import { getClient, initWhatsappForNumber } from "./whatsapp.js";
import { log } from "./logger.js";
import { createFixedWindowRateLimiter, isAuthorized } from "./control-api-security.js";

const startedAt = Date.now();
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

async function reconnectDisconnected(bot) {
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
                await initWhatsappForNumber(bot, uid, number);
            } catch (error) {
                failed += 1;
                log.error(`Control API reconnect failed for masked number ${maskNumber(number)}: ${error.message}`);
            }
        }
    }

    return { attempted, skipped, failed };
}

export async function startControlApi({ bot, botInfo }) {
    if (!CONTROL_API_ENABLED) {
        log.info("Android control API is disabled.");
        return null;
    }

    if (CONTROL_API_TOKEN.length < 32) {
        log.error("CONTROL_API_TOKEN must contain at least 32 characters. Control API was not started.");
        return null;
    }

    const generalLimit = createFixedWindowRateLimiter({ maxRequests: 60, windowMs: 60_000 });

    const server = http.createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader("X-Request-Id", requestId);

        try {
            const remoteAddress = req.socket.remoteAddress || "unknown";
            const rate = generalLimit(remoteAddress);
            if (!rate.allowed) {
                req.resume();
                return sendJson(
                    res,
                    429,
                    { error: "Too many requests.", requestId },
                    { "Retry-After": String(rate.retryAfterSeconds) }
                );
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
                const whatsapp = sessionSnapshot();
                return sendJson(res, 200, {
                    service: "SHOCO Control API",
                    apiVersion: 1,
                    serverTime: new Date().toISOString(),
                    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
                    telegram: {
                        connected: true,
                        username: botInfo?.username || null,
                    },
                    mode: getMode(),
                    users: getUsers().length,
                    deployedBots: deployedBots.size,
                    whatsapp,
                    capabilities: ["status.read", "sessions.reconnectDisconnected"],
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
                    return sendJson(
                        res,
                        429,
                        { error: "Reconnect is cooling down.", requestId },
                        { "Retry-After": String(Math.ceil(cooldownRemaining / 1000)) }
                    );
                }

                reconnectInProgress = true;
                lastReconnectAt = Date.now();
                try {
                    const result = await reconnectDisconnected(bot);
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
            log.error(`Control API request ${requestId} failed: ${error.message}`);
            if (!res.headersSent) {
                return sendJson(res, 500, { error: "Internal server error.", requestId });
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
