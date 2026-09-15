import http from "http";
import dns from "dns/promises";
import net from "net";
import tls from "tls";
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

const SAFE_MENU = [
    {
        id: "sessions",
        title: "WhatsApp",
        items: [
            { id: "refresh", title: "Refresh status", input: false },
            { id: "pair", title: "Pair WhatsApp", input: true, hint: "Phone with country code, e.g. 9477..." },
            { id: "reconnect", title: "Reconnect offline", input: false },
        ],
    },
    {
        id: "tools",
        title: "Tools",
        items: [
            { id: "quote", title: "Random quote", input: false },
            { id: "weather", title: "Weather", input: true, hint: "City name" },
            { id: "shorten", title: "Shorten link", input: true, hint: "https://example.com/long-link" },
        ],
    },
    {
        id: "osint",
        title: "Public OSINT",
        items: [
            { id: "whois", title: "Domain registration", input: true, hint: "example.com" },
            { id: "dns", title: "DNS records", input: true, hint: "example.com" },
            { id: "ip_info", title: "IP information", input: true, hint: "8.8.8.8" },
            { id: "ssl", title: "SSL certificate", input: true, hint: "example.com" },
        ],
    },
    {
        id: "code",
        title: "Code tools",
        items: [
            { id: "validate_json", title: "Validate JSON", input: true, multiline: true, hint: "Paste JSON" },
            { id: "format_json", title: "Format JSON", input: true, multiline: true, hint: "Paste JSON" },
            { id: "code_stats", title: "Code statistics", input: true, multiline: true, hint: "Paste code" },
            { id: "extract_functions", title: "List functions", input: true, multiline: true, hint: "Paste JavaScript" },
        ],
    },
];

const QUOTES = [
    "Small progress is still progress.",
    "Make it work, then make it clear, then make it fast.",
    "Consistency turns difficult work into ordinary work.",
    "The best debugging tool is a clear model of the system.",
    "Build the smallest safe thing that genuinely works.",
];

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

function httpError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

async function readJsonBody(req, maximumBytes = 64 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maximumBytes) throw httpError("Request body is too large.", 413);
        chunks.push(chunk);
    }
    if (total === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw httpError("Request body must be valid JSON.");
    }
}

function requireInput(value, maximum = 50_000) {
    const input = String(value ?? "").trim();
    if (!input) throw httpError("Input is required.");
    if (input.length > maximum) throw httpError(`Input must be no longer than ${maximum} characters.`);
    return input;
}

function cleanHost(value) {
    const host = requireInput(value, 253).toLowerCase().replace(/^https?:\/\//, "").split(/[/:]/)[0];
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
        throw httpError("Enter a valid public domain name.");
    }
    return host;
}

function maskNumber(value) {
    const number = String(value).replace(/\D/g, "");
    if (number.length <= 4) return "••••";
    return `${"•".repeat(Math.min(8, number.length - 4))}${number.slice(-4)}`;
}

function sessionSnapshot() {
    const sessions = [];
    for (const [uid, numbers] of Object.entries(getAllPairs())) {
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
    let attempted = 0;
    let skipped = 0;
    let failed = 0;
    for (const [uid, numbers] of Object.entries(getAllPairs())) {
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
                log.error(`Reconnect failed for ${maskNumber(number)}: ${error.message}`);
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
        throw httpError("Enter a phone number with country code and 8 to 15 digits.");
    }
    if (numberAlreadySaved(number)) throw httpError("That WhatsApp number is already saved.", 409);

    const ownedNumbers = getAllPairs()[ANDROID_CONTROL_UID] || [];
    if (ownedNumbers.length >= MAX_PAIR_PER_USER) {
        throw httpError(`The maximum of ${MAX_PAIR_PER_USER} Android-managed numbers has been reached.`, 409);
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

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: { "User-Agent": "SHOCO-Control/4.0" },
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw httpError(`External service returned HTTP ${response.status}.`, 502);
    return response.json();
}

async function runSafeTool(action, rawInput) {
    if (action === "quote") {
        return QUOTES[Math.floor(Math.random() * QUOTES.length)];
    }

    if (action === "weather") {
        const city = requireInput(rawInput, 100);
        const data = await fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        const current = data.current_condition?.[0];
        const area = data.nearest_area?.[0];
        if (!current) throw httpError("Weather data is unavailable.", 502);
        const place = area?.areaName?.[0]?.value || city;
        const description = current.weatherDesc?.[0]?.value || "Unknown";
        return [
            `Location: ${place}`,
            `Condition: ${description}`,
            `Temperature: ${current.temp_C} °C`,
            `Feels like: ${current.FeelsLikeC} °C`,
            `Humidity: ${current.humidity}%`,
            `Wind: ${current.windspeedKmph} km/h`,
        ].join("\n");
    }

    if (action === "shorten") {
        const value = requireInput(rawInput, 2_000);
        let parsed;
        try {
            parsed = new URL(value);
        } catch {
            throw httpError("Enter a valid URL.");
        }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw httpError("Only normal HTTP or HTTPS links can be shortened.");
        }
        const response = await fetch(
            `https://is.gd/create.php?format=simple&url=${encodeURIComponent(parsed.toString())}`,
            { signal: AbortSignal.timeout(10_000) }
        );
        const output = (await response.text()).trim();
        if (!response.ok) throw httpError(output || "Link shortening failed.", 502);
        return output;
    }

    if (action === "dns") {
        const host = cleanHost(rawInput);
        const records = await dns.resolveAny(host);
        return records.length ? JSON.stringify(records, null, 2) : "No DNS records found.";
    }

    if (action === "ip_info") {
        const ip = requireInput(rawInput, 64);
        if (!net.isIP(ip)) throw httpError("Enter a valid IPv4 or IPv6 address.");
        const data = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
        if (!data.success) throw httpError(data.message || "IP lookup failed.", 502);
        return [
            `IP: ${data.ip}`,
            `Country: ${data.country || "-"}`,
            `Region: ${data.region || "-"}`,
            `City: ${data.city || "-"}`,
            `ISP: ${data.connection?.isp || "-"}`,
            `ASN: ${data.connection?.asn || "-"}`,
            `Timezone: ${data.timezone?.id || "-"}`,
        ].join("\n");
    }

    if (action === "ssl") {
        const host = cleanHost(rawInput);
        return await new Promise((resolve, reject) => {
            const socket = tls.connect({
                host,
                port: 443,
                servername: host,
                rejectUnauthorized: true,
                timeout: 8_000,
            }, () => {
                const cert = socket.getPeerCertificate();
                socket.end();
                resolve([
                    `Host: ${host}`,
                    `Subject: ${cert.subject?.CN || "-"}`,
                    `Issuer: ${cert.issuer?.CN || "-"}`,
                    `Valid from: ${cert.valid_from || "-"}`,
                    `Valid until: ${cert.valid_to || "-"}`,
                    `Fingerprint: ${cert.fingerprint256 || cert.fingerprint || "-"}`,
                ].join("\n"));
            });
            socket.once("timeout", () => {
                socket.destroy();
                reject(httpError("SSL connection timed out.", 502));
            });
            socket.once("error", (error) => reject(httpError(`SSL check failed: ${error.message}`, 502)));
        });
    }

    if (action === "whois") {
        const host = cleanHost(rawInput);
        const data = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(host)}`);
        const event = (name) => data.events?.find((item) => item.eventAction === name)?.eventDate || "-";
        const nameservers = (data.nameservers || []).map((item) => item.ldhName).filter(Boolean);
        return [
            `Domain: ${data.ldhName || host}`,
            `Handle: ${data.handle || "-"}`,
            `Status: ${(data.status || []).join(", ") || "-"}`,
            `Registered: ${event("registration")}`,
            `Expires: ${event("expiration")}`,
            `Nameservers: ${nameservers.join(", ") || "-"}`,
        ].join("\n");
    }

    if (action === "validate_json") {
        const input = requireInput(rawInput);
        try {
            const value = JSON.parse(input);
            const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
            const size = Array.isArray(value) ? value.length : type === "object" ? Object.keys(value).length : 1;
            return `Valid JSON\nType: ${type}\nTop-level items: ${size}`;
        } catch (error) {
            throw httpError(`Invalid JSON: ${error.message}`);
        }
    }

    if (action === "format_json") {
        const input = requireInput(rawInput);
        try {
            return JSON.stringify(JSON.parse(input), null, 2);
        } catch (error) {
            throw httpError(`Invalid JSON: ${error.message}`);
        }
    }

    if (action === "code_stats") {
        const input = requireInput(rawInput);
        const lines = input.split(/\r?\n/);
        return [
            `Lines: ${lines.length}`,
            `Non-empty lines: ${lines.filter((line) => line.trim()).length}`,
            `Comment lines: ${lines.filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line)).length}`,
            `Words: ${(input.match(/\b[\w$]+\b/g) || []).length}`,
            `Characters: ${input.length}`,
        ].join("\n");
    }

    if (action === "extract_functions") {
        const input = requireInput(rawInput);
        const names = new Set();
        for (const match of input.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1]);
        for (const match of input.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) names.add(match[1]);
        for (const match of input.matchAll(/\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
            if (!["if", "for", "while", "switch", "catch"].includes(match[1])) names.add(match[1]);
        }
        return names.size ? [...names].sort().join("\n") : "No named functions found.";
    }

    throw httpError("That action is not available.", 404);
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
    const toolLimit = createFixedWindowRateLimiter({ maxRequests: 30, windowMs: 60_000 });

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

            if (req.method === "GET" && url.pathname === "/api/v1/menu") {
                return sendJson(res, 200, { categories: SAFE_MENU, requestId });
            }

            if (req.method === "GET" && url.pathname === "/api/v1/status") {
                return sendJson(res, 200, {
                    service: "SHOCO Control API",
                    apiVersion: 2,
                    serverTime: new Date().toISOString(),
                    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
                    server: { online: true, runtime: process.version },
                    mode: getMode(),
                    legacyUsers: getUsers().length,
                    whatsapp: sessionSnapshot(),
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
                const body = await readJsonBody(req, 1024);
                const result = await requestPairingCode(body.number);
                return sendJson(res, 201, {
                    ok: true,
                    message: "Enter this code in WhatsApp Linked Devices.",
                    result,
                    requestId,
                });
            }

            if (req.method === "POST" && url.pathname === "/api/v1/tools/run") {
                const actionRate = toolLimit(remoteAddress);
                if (!actionRate.allowed) {
                    req.resume();
                    return sendJson(res, 429, { error: "Too many tool requests.", requestId }, {
                        "Retry-After": String(actionRate.retryAfterSeconds),
                    });
                }
                const body = await readJsonBody(req);
                const action = requireInput(body.action, 64);
                const output = await runSafeTool(action, body.input);
                return sendJson(res, 200, { ok: true, action, output, requestId });
            }

            if (req.method === "POST" && url.pathname === "/api/v1/actions/reconnect-disconnected") {
                req.resume();
                if (reconnectInProgress) {
                    return sendJson(res, 409, { error: "A reconnect request is already running.", requestId });
                }
                const cooldownRemaining = 30_000 - (Date.now() - lastReconnectAt);
                if (cooldownRemaining > 0) {
                    return sendJson(res, 429, { error: "Reconnect is cooling down.", requestId }, {
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
            if (statusCode >= 500) log.error(`API request ${requestId} failed: ${error.message}`);
            if (!res.headersSent) {
                return sendJson(res, statusCode, {
                    error: statusCode >= 500 ? "Internal server error." : error.message,
                    requestId,
                });
            }
            res.end();
        }
    });

    server.requestTimeout = 20_000;
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
