import crypto from "crypto";

export function isAuthorized(authorizationHeader, expectedToken) {
    if (typeof authorizationHeader !== "string" || typeof expectedToken !== "string") return false;

    const match = authorizationHeader.match(/^Bearer ([^\s]+)$/);
    if (!match) return false;

    const actualDigest = crypto.createHash("sha256").update(match[1], "utf8").digest();
    const expectedDigest = crypto.createHash("sha256").update(expectedToken, "utf8").digest();
    return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

export function createFixedWindowRateLimiter({ maxRequests, windowMs, now = Date.now }) {
    const buckets = new Map();

    return function allow(key) {
        const currentTime = now();
        const current = buckets.get(key);

        if (!current || current.resetAt <= currentTime) {
            buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
            return { allowed: true, retryAfterSeconds: 0 };
        }

        current.count += 1;
        if (current.count <= maxRequests) {
            return { allowed: true, retryAfterSeconds: 0 };
        }

        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - currentTime) / 1000)),
        };
    };
}
