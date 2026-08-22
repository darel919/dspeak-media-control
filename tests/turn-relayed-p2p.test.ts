import assert from "node:assert/strict";
import test from "node:test";
import {
  createP2PRoute,
  MEDIA_ROUTE_KIND,
  P2P_PATH,
  qualificationUsesRelay,
} from "../src/protocol.ts";
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

function relayReport(peerId: string) {
  return {
    peerId,
    path: P2P_PATH.RELAY,
    localCandidateType: "relay",
    remoteCandidateType: "host",
    rttMs: 12,
    protocol: "udp",
  };
}

function directReport(peerId: string) {
  return {
    peerId,
    path: P2P_PATH.DIRECT,
    localCandidateType: "srflx",
    remoteCandidateType: "host",
    rttMs: 8,
    protocol: "udp",
  };
}

function seedQualification(instance: MediaRoomDO, reports: () => unknown) {
  instance.route = createP2PRoute(P2P_PATH.DIRECT, 3, 0, "qualifying-direct");
  instance.epoch = 3;
  instance.participants.set("user-1:device-1", { peerId: "peer-1", ws: null });
  instance.participants.set("user-2:device-2", { peerId: "peer-2", ws: null });
  instance.qualificationStartedAt = Date.now() - 5000;
  instance.mediaPolicy = { audioLatencyProfile: "standard" };
  instance.qualificationFallbackRoute = null;
  instance.qualificationState.set("peer-1", {
    ready: true,
    qualifiedPeers: new Set(["peer-2"]),
    candidateReports: [reports() as Record<string, unknown>],
  });
  instance.qualificationState.set("peer-2", {
    ready: true,
    qualifiedPeers: new Set(["peer-1"]),
    candidateReports: [reports() as Record<string, unknown>],
  });
}

test("qualificationUsesRelay derives the room path from evidence", () => {
  assert.equal(qualificationUsesRelay([directReport("a")]), false);
  assert.equal(qualificationUsesRelay([relayReport("a")]), true);
  assert.equal(
    qualificationUsesRelay([directReport("a"), relayReport("b")]),
    true,
  );
  assert.equal(qualificationUsesRelay([]), false);
});

test("qualified relay mesh commits P2P/RELAY with correct reason", () => {
  const instance = room();
  seedQualification(instance, () => relayReport("peer-2"));

  instance.checkQualificationComplete();

  assert.equal(instance.route.kind, MEDIA_ROUTE_KIND.P2P);
  assert.equal(instance.route.path, P2P_PATH.RELAY);
  assert.equal(instance.route.reason, "qualified-relay-mesh");
  assert.equal(instance.routeDecision?.p2pPath, P2P_PATH.RELAY);
});

test("qualified direct mesh keeps P2P/DIRECT", () => {
  const instance = room();
  seedQualification(instance, () => directReport("peer-2"));

  instance.checkQualificationComplete();

  assert.equal(instance.route.kind, MEDIA_ROUTE_KIND.P2P);
  assert.equal(instance.route.path, P2P_PATH.DIRECT);
  assert.equal(instance.route.reason, "qualified-direct-mesh");
  assert.equal(instance.routeDecision?.p2pPath, P2P_PATH.DIRECT);
});

test("missing required peer report blocks commit", () => {
  const instance = room();
  instance.route = createP2PRoute(P2P_PATH.DIRECT, 3, 0, "qualifying-direct");
  instance.epoch = 3;
  instance.participants.set("user-1:device-1", { peerId: "peer-1", ws: null });
  instance.participants.set("user-2:device-2", { peerId: "peer-2", ws: null });
  instance.qualificationStartedAt = Date.now() - 5000;
  instance.mediaPolicy = { audioLatencyProfile: "standard" };
  instance.qualificationFallbackRoute = null;
  instance.qualificationState.set("peer-1", {
    ready: true,
    qualifiedPeers: new Set(["peer-2"]),
    candidateReports: [relayReport("peer-2")],
  });

  let committed = false;
  const realCommit = instance.commitRoute.bind(instance);
  instance.commitRoute = (...args: Parameters<MediaRoomDO["commitRoute"]>) => {
    committed = true;
    return realCommit(...args);
  };

  instance.checkQualificationComplete();

  assert.equal(committed, false, "incomplete qualification must not commit");
});
