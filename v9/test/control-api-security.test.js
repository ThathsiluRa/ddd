import test from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowRateLimiter, isAuthorized } from "../path/control-api-security.js";

test("accepts only an exact bearer token", () => {
    const token = "a-secure-token-that-is-long-enough";
    assert.equal(isAuthorized(`Bearer ${token}`, token), true);
    assert.equal(isAuthorized(`bearer ${token}`, token), false);
    assert.equal(isAuthorized(`Bearer ${token}extra`, token), false);
    assert.equal(isAuthorized(undefined, token), false);
});

test("fixed-window limiter blocks requests over the configured maximum", () => {
    let clock = 1_000;
    const allow = createFixedWindowRateLimiter({
        maxRequests: 2,
        windowMs: 1_000,
        now: () => clock,
    });

    assert.equal(allow("client").allowed, true);
    assert.equal(allow("client").allowed, true);
    assert.equal(allow("client").allowed, false);

    clock += 1_001;
    assert.equal(allow("client").allowed, true);
});
