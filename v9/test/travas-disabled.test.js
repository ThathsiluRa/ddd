import test from "node:test";
import assert from "node:assert/strict";
import travas from "../path/travas.js";

test("legacy disruptive payload methods fail closed", async () => {
    const blockedMethods = [
        "crash",
        "freeze1",
        "sendHeavyAndDelete",
        "banNumberV2",
        "crashgroup",
    ];

    for (const method of blockedMethods) {
        await assert.rejects(
            () => travas[method](),
            /functionality is disabled/
        );
    }
});
