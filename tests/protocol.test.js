import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert";

describe("dspeak-media-control protocol", () => {
  it("creates local route", async () => {
    const { createLocalRoute } = await import("../src/protocol.js");
    const route = createLocalRoute(1, 5, "test");
    assert.strictEqual(route.kind, "local");
    assert.strictEqual(route.epoch, 1);
    assert.strictEqual(route.sourceRevision, 5);
    assert.strictEqual(route.reason, "test");
  });

  it("creates P2P route", async () => {
    const { createP2PRoute, P2P_PATH } = await import("../src/protocol.js");
    const route = createP2PRoute(P2P_PATH.DIRECT, 2, 3, "qualified");
    assert.strictEqual(route.kind, "p2p");
    assert.strictEqual(route.path, "direct");
    assert.strictEqual(route.epoch, 2);
    assert.strictEqual(route.sourceRevision, 3);
  });

  it("creates SFU route", async () => {
    const { createSFURoute, SFU_PROVIDER } = await import("../src/protocol.js");
    const route = createSFURoute(
      SFU_PROVIDER.CLOUDFLARE_REALTIME,
      3,
      4,
      "fallback",
    );
    assert.strictEqual(route.kind, "sfu");
    assert.strictEqual(route.provider, "cloudflare-realtime");
    assert.strictEqual(route.epoch, 3);
  });

  it("validates route for direct mode", async () => {
    const {
      validateRouteForMode,
      createLocalRoute,
      createP2PRoute,
      createSFURoute,
      P2P_PATH,
      SFU_PROVIDER,
      MEDIA_ROUTE_KIND,
    } = await import("../src/protocol.js");

    const localRoute = createLocalRoute(1, 1, "test");
    assert.ok(validateRouteForMode(localRoute, "direct").valid);

    const p2pDirect = createP2PRoute(P2P_PATH.DIRECT, 1, 1, "test");
    assert.ok(validateRouteForMode(p2pDirect, "direct").valid);

    const p2pRelay = createP2PRoute(P2P_PATH.RELAY, 1, 1, "test");
    assert.ok(!validateRouteForMode(p2pRelay, "direct").valid);

    const sfuRoute = createSFURoute(
      SFU_PROVIDER.CLOUDFLARE_REALTIME,
      1,
      1,
      "test",
    );
    assert.ok(!validateRouteForMode(sfuRoute, "direct").valid);
  });

  it("compares route epochs", async () => {
    const { compareRouteEpoch, createP2PRoute, P2P_PATH } =
      await import("../src/protocol.js");

    const route1 = createP2PRoute(P2P_PATH.DIRECT, 1, 5, "test");
    const route2 = createP2PRoute(P2P_PATH.DIRECT, 2, 3, "test");
    const route3 = createP2PRoute(P2P_PATH.DIRECT, 2, 5, "test");
    const route4 = createP2PRoute(P2P_PATH.DIRECT, 2, 7, "test");

    assert.strictEqual(compareRouteEpoch(route1, route2), -1);
    assert.strictEqual(compareRouteEpoch(route2, route1), 1);
    assert.strictEqual(compareRouteEpoch(route2, route3), -1);
    assert.strictEqual(compareRouteEpoch(route3, route4), -1);
    assert.strictEqual(compareRouteEpoch(route4, route3), 1);
  });
});
