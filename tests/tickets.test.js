import { describe, it } from "node:test";
import assert from "node:assert";

describe("dspeak-media-control tickets", () => {
  it("exports ticket functions", async () => {
    const mod = await import("../src/tickets.js");
    assert.ok(typeof mod.verifyMediaTicket === "function");
    assert.ok(typeof mod.signProviderTicket === "function");
    assert.ok(typeof mod.getMediaVerifyKey === "function");
    assert.ok(typeof mod.getProviderSigningKey === "function");
  });
});
