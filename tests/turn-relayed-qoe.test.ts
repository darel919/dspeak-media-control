import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_CONTROL_MESSAGE_TYPES,
  P2P_PATH,
  createP2PRoute,
} from "../src/protocol.ts";
import { rankQoeCandidates, qoeWouldImprove } from "../src/qoe.ts";
import { MediaRoomDO } from "../src/MediaRoomDO.ts";

function room() {
  const storage = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    setAlarm: async () => {},
  };
  const instance = new MediaRoomDO(
    { storage, getWebSockets: () => [] },
    {
      MEDIA_CONTROL_ADMIN_TOKEN: "admin",
      CLOUDFLARE_REALTIME_APP_ID: "app",
      CLOUDFLARE_REALTIME_APP_SECRET: "secret",
    },
  );
  instance.stateLoaded = true;
  return instance;
}

function p2pCandidate(overrides = {}) {
  return {
    provider: "p2p",
    paths: [{ rttMs: 12, jitterMs: 1, packetLossPercent: 0 }],
    stableSince: Date.now() - 20_000,
    ...overrides,
  };
}

function sfuCandidate(overrides = {}) {
  return {
    provider: "cloudflare-realtime",
    paths: [{ rttMs: 35, jitterMs: 1, packetLossPercent: 0 }],
    stableSince: Date.now() - 60_000,
    ...overrides,
  };
}

test("relay P2P wins against a materially worse SFU", () => {
  const ranked = rankQoeCandidates([sfuCandidate(), p2pCandidate()], {
    objective: "ultra-low",
  });
  assert.equal(ranked[0].provider, "p2p");
});

test("badly placed TURN loses to a nearby SFU", () => {
  const ranked = rankQoeCandidates(
    [
      sfuCandidate({ paths: [{ rttMs: 18 }] }),
      p2pCandidate({ paths: [{ rttMs: 50 }] }),
    ],
    { objective: "ultra-low" },
  );
  assert.equal(ranked[0].provider, "cloudflare-realtime");
});

test("tiny differences do not trigger migration", () => {
  const active = sfuCandidate({ paths: [{ rttMs: 19 }] });
  const candidate = p2pCandidate({ paths: [{ rttMs: 21 }] });
  assert.equal(
    qoeWouldImprove(active, candidate, Date.now(), {
      objective: "standard",
    }),
    false,
  );
});

test("unstable candidates never migrate", () => {
  const active = sfuCandidate();
  const candidate = p2pCandidate({ stableSince: Date.now() - 100 });
  assert.equal(
    qoeWouldImprove(active, candidate, Date.now(), {
      objective: "standard",
    }),
    false,
  );
});

test("failed active provider lets viable relay recover the room", async () => {
  const instance = room();
  instance.route = createP2PRoute(P2P_PATH.DIRECT, 5, 7, "qualifying-direct");
  instance.epoch = 5;
  instance.sourceRevision = 8;
  instance.qualificationFallbackRoute = {
    kind: "sfu",
    provider: "cloudflare-realtime",
    epoch: 4,
    sourceRevision: 7,
    reason: "qualification-fallback",
  };
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws: null,
    sources: new Set(),
    providerCapabilities: new Set(["cloudflare-realtime"]),
  });
  let committed = null;
  const realCommit = instance.commitRoute.bind(instance);
  instance.commitRoute = (route) => {
    committed = route;
    return realCommit(route);
  };

  await instance.handleP2PFailure(
    { userId: "user-1", deviceId: "device-1", lastHeartbeat: Date.now() },
    "ice-failed",
  );

  assert.ok(committed, "fallback route must be restored");
  assert.equal(committed.kind, "sfu");
});

test("stale relay qualification cannot replace a newer SFU route", async () => {
  const instance = room();
  instance.route = {
    kind: "sfu",
    provider: "cloudflare-realtime",
    epoch: 4,
    sourceRevision: 0,
    reason: "provider-transition",
  };
  instance.epoch = 4;

  await instance.handleMessage(
    {
      readyState: 1,
      close() {},
      send() {},
    },
    {
      authenticated: true,
      userId: "user-1",
      deviceId: "device-1",
      peerId: "peer-1",
    },
    {
      type: MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED,
      data: { epoch: 3, qualifiedPeerIds: [], candidateReports: [] },
    },
  );

  assert.equal(instance.route.kind, "sfu");
  assert.equal(instance.qualificationState.size, 0);
});
