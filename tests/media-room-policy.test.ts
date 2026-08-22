import assert from "node:assert/strict";
import test from "node:test";
import { MediaRoomDO } from "../src/MediaRoomDO.ts";
import {
  applyMediaPolicyUpdate,
  getRequestedAudioLatencyProfile,
  normalizeMediaPolicySnapshot,
} from "../src/media-room-policy.ts";

function env(adminToken = "admin-token") {
  return { MEDIA_CONTROL_ADMIN_TOKEN: adminToken };
}

function storageBackedRoom() {
  const store = new Map();
  const storage = {
    get: async (key) =>
      store.has(key) ? structuredClone(store.get(key)) : null,
    put: async (key, value) => {
      store.set(key, structuredClone(value));
    },
    delete: async (key) => {
      store.delete(key);
    },
    setAlarm: async () => {},
  };
  const room = new MediaRoomDO({ storage, getWebSockets: () => [] }, env());
  room.stateLoaded = true;
  room.channelId = "channel-1";
  room.broadcastTopology = () => {};
  room.maybeStartQualification = () => {};
  return { room, store };
}

const ULTRA_LOW = {
  audioLatencyProfile: "ultra-low",
  revision: 3,
  updatedAt: "2026-08-19T00:00:00.000Z",
};

test("media policy snapshot normalization rejects malformed input", () => {
  assert.equal(normalizeMediaPolicySnapshot(null), null);
  assert.equal(normalizeMediaPolicySnapshot("ultra-low"), null);
  assert.equal(normalizeMediaPolicySnapshot({ revision: 2 }), null);
  assert.equal(
    normalizeMediaPolicySnapshot({
      audioLatencyProfile: "sub-ms-turbo",
      revision: 2,
    }),
    null,
  );
  assert.equal(
    normalizeMediaPolicySnapshot({
      audioLatencyProfile: "standard",
      revision: 0,
    }),
    null,
  );
  const snapshot = normalizeMediaPolicySnapshot(ULTRA_LOW);
  assert.deepEqual(snapshot, ULTRA_LOW);
});

test("signed admin request applies a new media policy", async () => {
  const { room } = storageBackedRoom();
  const response = await room.fetch(
    new Request("https://room.test/v1/room/channel-1/media-policy", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ULTRA_LOW),
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.changed, true);
  assert.equal(room.mediaPolicy.audioLatencyProfile, "ultra-low");
  assert.equal(getRequestedAudioLatencyProfile(room), "ultra-low");
});

test("unsigned or wrong-token requests are rejected", async () => {
  const { room } = storageBackedRoom();
  const url = "https://room.test/v1/room/channel-1/media-policy";
  const unauthorized = await room.fetch(
    new Request(url, {
      method: "POST",
      body: JSON.stringify(ULTRA_LOW),
    }),
  );
  assert.equal(unauthorized.status, 401);
  const wrongToken = await room.fetch(
    new Request(url, {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
      body: JSON.stringify(ULTRA_LOW),
    }),
  );
  assert.equal(wrongToken.status, 401);
});

test("malformed policy payload is a bad request and changes nothing", async () => {
  const { room } = storageBackedRoom();
  const response = await room.fetch(
    new Request("https://room.test/v1/room/channel-1/media-policy", {
      method: "POST",
      headers: { Authorization: "Bearer admin-token" },
      body: JSON.stringify({ audioLatencyProfile: "turbo", revision: 9 }),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(room.mediaPolicy, null);
});

test("lower revision is rejected as stale", () => {
  const { room } = storageBackedRoom();
  applyMediaPolicyUpdate(room, ULTRA_LOW);
  const result = applyMediaPolicyUpdate(room, {
    audioLatencyProfile: "standard",
    revision: 2,
    updatedAt: null,
  });
  assert.deepEqual(result, { accepted: false, reason: "stale-revision" });
  assert.equal(room.mediaPolicy.revision, 3);
  assert.equal(room.mediaPolicy.audioLatencyProfile, "ultra-low");
});

test("equal revision with identical content is idempotent", () => {
  const { room } = storageBackedRoom();
  applyMediaPolicyUpdate(room, ULTRA_LOW);
  let reevaluations = 0;
  room.maybeStartQualification = () => {
    reevaluations += 1;
  };
  const result = applyMediaPolicyUpdate(room, { ...ULTRA_LOW });
  assert.equal(result.accepted, true);
  assert.equal(result.changed, false);
  assert.equal(reevaluations, 0);
  assert.equal(room.mediaPolicy.revision, 3);
});

test("equal revision with conflicting content is rejected", () => {
  const { room } = storageBackedRoom();
  applyMediaPolicyUpdate(room, ULTRA_LOW);
  const result = applyMediaPolicyUpdate(room, {
    audioLatencyProfile: "standard",
    revision: 3,
    updatedAt: ULTRA_LOW.updatedAt,
  });
  assert.deepEqual(result, {
    accepted: false,
    reason: "conflicting-revision",
  });
  assert.equal(room.mediaPolicy.audioLatencyProfile, "ultra-low");
});

test("policy update persists to DO storage for hibernation reload", async () => {
  const { room, store } = storageBackedRoom();
  applyMediaPolicyUpdate(room, ULTRA_LOW);
  assert.deepEqual(structuredClone(store.get("mediaPolicy")), ULTRA_LOW);

  const revived = new MediaRoomDO(
    {
      storage: {
        get: async (key: string) =>
          store.has(key) ? structuredClone(store.get(key)) : null,
        put: async () => {},
        delete: async () => {},
        setAlarm: async () => {},
      },
      getWebSockets: () => [],
    },
    env(),
  );
  await revived.loadDurableState();
  assert.deepEqual(revived.mediaPolicy, ULTRA_LOW);
});

test("dormant-room reset preserves the requested channel policy", async () => {
  const { room, store } = storageBackedRoom();
  applyMediaPolicyUpdate(room, ULTRA_LOW);
  room.route = { kind: "local", epoch: 4, sourceRevision: 2, reason: "x" };
  await room.resetDormantRoomState();
  assert.deepEqual(structuredClone(store.get("mediaPolicy")), ULTRA_LOW);
  assert.equal(room.mediaPolicy.audioLatencyProfile, "ultra-low");
});

test("policy update triggers exactly one bounded topology reevaluation", () => {
  const { room } = storageBackedRoom();
  let broadcasts = 0;
  let reevaluations = 0;
  room.broadcastTopology = () => {
    broadcasts += 1;
  };
  room.maybeStartQualification = () => {
    reevaluations += 1;
  };
  applyMediaPolicyUpdate(room, ULTRA_LOW);
  assert.equal(broadcasts, 1);
  assert.equal(reevaluations, 1);
});

test("topology snapshot exposes requested audio latency profile", () => {
  const { room } = storageBackedRoom();
  assert.equal(room.buildTopologySnapshot().audioLatencyProfile, "standard");
  applyMediaPolicyUpdate(room, ULTRA_LOW);
  const snapshot = room.buildTopologySnapshot();
  assert.equal(snapshot.audioLatencyProfile, "ultra-low");
  assert.deepEqual(snapshot.mediaPolicy, ULTRA_LOW);
});
