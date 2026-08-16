import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_ROUTE_KIND,
  SFU_PROVIDER,
  createSFURoute,
  getMediaChannelParticipantLimit,
} from "../src/protocol.js";
import { handleRoomMessage } from "../src/media-room-messages.ts";
import { MediaRoomDO } from "../src/MediaRoomDO.ts";

function createTestRoom(overrides = {}) {
  const values = new Map([
    ["route", createSFURoute(SFU_PROVIDER.CLOUDFLARE_REALTIME, 1, 0, "test")],
    ["epoch", 1],
    ["sourceRevision", 0],
    ["publishedSources", []],
    [
      "providerHealth",
      { [SFU_PROVIDER.CLOUDFLARE_REALTIME]: { healthy: true } },
    ],
    ["providerConfig", { id: "cloudflare-primary" }],
    ["roomRevision", 0n],
  ]);
  const storage = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };
  const instance = new MediaRoomDO(
    { storage, getWebSockets: () => [] },
    {
      CLOUDFLARE_REALTIME_APP_ID: "app",
      CLOUDFLARE_REALTIME_APP_SECRET: "secret",
      ...overrides,
    },
  );
  instance.stateLoaded = true;
  return instance;
}

function createMockWs() {
  const obj = {
    readyState: 1,
    id: Math.random().toString(36).substring(7),
    _messages: [],
    serializeAttachment: () => {},
    send: function (msg) {
      const parsed = JSON.parse(msg);
      console.log(
        "MOCK WS SEND CALLED, id:",
        this.id,
        "messages before:",
        this._messages.length,
      );
      this._messages.push({ type: parsed.type, data: parsed.data });
      console.log(
        "MOCK WS SEND CALLED, id:",
        this.id,
        "messages after:",
        this._messages.length,
      );
    },
    get messages() {
      return this._messages;
    },
    close: () => {},
  };
  return obj;
}

function createMockSession(overrides = {}) {
  return {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    connectionMode: "auto",
    mediaSessionId: "test-session",
    ...overrides,
  };
}

test("Phase 1: ROOM_REVISION_CONFLICT returns NACK via OPERATION_ACK not fatal ERROR", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio"]),
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);

  // First operation succeeds
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
    data: {
      muted: false,
      deafened: false,
      operationId: "op-1",
      expectedRoomRevision: "0",
    },
  });

  // Simulate revision advancing on server
  instance.roomRevision = 2n;

  // Client sends with stale expectedRoomRevision - should get NACK, not fatal ERROR
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
    data: {
      muted: true,
      deafened: false,
      operationId: "op-2",
      expectedRoomRevision: "0",
    },
  });

  const ackMsg = ws.messages.findLast(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.ok(ackMsg, "Should receive OPERATION_ACK");
  assert.equal(ackMsg.data.accepted, false);
  assert.equal(ackMsg.data.code, "ROOM_REVISION_CONFLICT");
  assert.equal(ackMsg.data.retryable, true);
  assert.ok(
    ackMsg.data.canonicalState,
    "Should include canonical snapshot for reconciliation",
  );

  // Should NOT have received fatal ERROR message
  const errorMsg = ws.messages.find(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.ERROR,
  );
  assert.equal(
    errorMsg,
    undefined,
    "Should not send fatal ERROR for revision conflict",
  );
});

test("Phase 1: STALE_CONNECTION_EPOCH returns NACK via OPERATION_ACK not fatal ERROR", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio"]),
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 2);

  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
    data: {
      muted: true,
      deafened: false,
      operationId: "op-3",
      connectionEpoch: 1,
    },
  });

  const ackMsg = ws.messages.findLast(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.ok(ackMsg, "Should receive OPERATION_ACK");
  assert.equal(ackMsg.data.accepted, false);
  assert.equal(ackMsg.data.code, "STALE_CONNECTION_EPOCH");
  assert.equal(ackMsg.data.retryable, true);
  assert.ok(
    ackMsg.data.canonicalState,
    "Should include canonical snapshot for reconciliation",
  );
  assert.equal(ackMsg.data.connectionEpoch, 2);

  const errorMsg = ws.messages.find(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.ERROR,
  );
  assert.equal(
    errorMsg,
    undefined,
    "Should not send fatal ERROR for stale epoch",
  );
});

test("Phase 1: Idempotent replay returns cached ACK with replayed flag", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio"]),
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);

  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
    data: {
      muted: true,
      deafened: false,
      operationId: "op-4",
      expectedRoomRevision: "0",
    },
  });

  // Replay same operationId
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
    data: {
      muted: true,
      deafened: false,
      operationId: "op-4",
      expectedRoomRevision: "0",
    },
  });

  const ackMsgs = ws.messages.filter(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.equal(ackMsgs.length, 2);
  assert.equal(
    ackMsgs[1].data.replayed,
    true,
    "Second ACK should have replayed flag",
  );
  assert.equal(ackMsgs[1].data.operationId, "op-4");
});

test("Phase 1: HEARTBEAT with state mismatch returns STATE_NACK and HEARTBEAT_ACK", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio"]),
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);

  // Server epoch is 1, client sends epoch 2 (mismatch)
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT,
    data: {
      sequence: 1,
      topologyEpoch: 2,
      sourceRevision: 0,
      lastAppliedRoomRevision: "0",
      connectionEpoch: 1,
    },
  });

  const stateNack = ws.messages.find(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.STATE_NACK,
  );
  assert.ok(stateNack, "Should receive STATE_NACK for topology mismatch");
  assert.ok(
    stateNack.data.topology,
    "STATE_NACK should include topology snapshot",
  );

  const hbAck = ws.messages.find(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK,
  );
  assert.ok(hbAck, "Should also receive HEARTBEAT_ACK for liveness");
});

// test("Phase 1: connection epoch is server-owned and increments per connection", async () => {
//   const instance = createTestRoom();
//   const ws = createMockWs();
//   const session = createMockSession({ authenticated: true }); // Pre-authenticated for test
//
//   // First connection - manually set up participant (simulating post-auth state)
//   instance.participantConnectionEpochs.clear();
//   instance.participants.set("user-1:device-1", {
//     userId: "user-1",
//     deviceId: "device-1",
//     peerId: "peer-1",
//     ws,
//     sources: new Set(["audio"]),
//     connectionEpoch: 1,
//   });
//   instance.isCurrentParticipantSession = () => true;
//
//   // Trigger getSession to increment epoch
//   instance.getSession(ws);
//
//   // Server should have assigned epoch 1
//   assert.equal(instance.participantConnectionEpochs.get("user-1:device-1"), 1);
//
//   // Simulate reconnect - epoch should increment
//   const ws2 = createMockWs();
//   const session2 = createMockSession({ authenticated: true, mediaSessionId: "test-session-2" });
//
//   instance.getSession(ws2);
//
//   assert.equal(instance.participantConnectionEpochs.get("user-1:device-1"), 2, "Epoch should increment on reconnect");
// });

test("Phase 1: roomRevision is BigInt, string comparison used consistently", async () => {
  const instance = createTestRoom();

  assert.equal(typeof instance.roomRevision, "bigint");

  instance.roomRevision = 1n;
  assert.equal(instance.roomRevision.toString(), "1");

  instance.roomRevision = 9223372036854775807n; // Max safe integer as BigInt
  assert.equal(instance.roomRevision.toString(), "9223372036854775807");

  // String comparison
  assert.ok("9223372036854775807" !== "9223372036854775806");
  assert.ok("9223372036854775807" === instance.roomRevision.toString());
});

test("Phase 1: operationResults Map persists and cleans up", async () => {
  const instance = createTestRoom();

  assert.ok(instance.operationResults instanceof Map);

  // Add some operations
  for (let i = 0; i < 5; i++) {
    instance.operationResults.set(`op-${i}`, {
      operationId: `op-${i}`,
      accepted: true,
    });
  }

  assert.equal(instance.operationResults.size, 5);

  // Test cleanup
  instance.cleanupOperationResults();
  assert.equal(
    instance.operationResults.size,
    5,
    "Should not clean up under threshold",
  );

  // Fill beyond threshold
  for (let i = 5; i < 1005; i++) {
    instance.operationResults.set(`op-${i}`, {
      operationId: `op-${i}`,
      accepted: true,
    });
  }

  assert.equal(instance.operationResults.size, 1005);
  instance.cleanupOperationResults();
  assert.ok(
    instance.operationResults.size <= 1000,
    "Should clean up to max size",
  );
});

test("Phase 1: applyCanonicalSnapshot builds complete topology with all fields", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio", "camera"]),
    muted: false,
    deafened: false,
    status: "connected",
    lastSeenAt: Date.now(),
    mediaCapabilities: {},
    capabilityProtocol: "video-codec-matrix-v1",
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);

  // Use the new applyCanonicalSnapshot method
  instance.applyCanonicalSnapshot(ws, "test-op", true, null, null);

  const ackMsg = ws.messages.findLast(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.ok(ackMsg);
  assert.ok(ackMsg.data.canonicalState);

  const snapshot = ackMsg.data.canonicalState;
  assert.ok(snapshot.route);
  assert.ok(snapshot.mode);
  assert.ok(typeof snapshot.epoch === "string");
  assert.ok(typeof snapshot.sourceRevision === "string");
  assert.ok(typeof snapshot.roomRevision === "string");
  assert.ok(Array.isArray(snapshot.participants));
  assert.ok(Array.isArray(snapshot.publishedSources));
});

test("Phase 1: participant-local operations don't use global roomRevision CAS incorrectly", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio"]),
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);

  // MEDIA_CAPABILITIES is participant-local, should not fail on revision mismatch
  instance.roomRevision = 5n;
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_CAPABILITIES,
    data: {
      mediaCapabilities: {},
      capabilityProtocol: "video-codec-matrix-v1",
      operationId: "op-cap-1",
    },
  });

  const ackMsg = ws.messages.findLast(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.ok(ackMsg);
  assert.equal(
    ackMsg.data.accepted,
    true,
    "MEDIA_CAPABILITIES should succeed despite roomRevision mismatch",
  );
});

test("Phase 1: MEDIA_SOURCES increments revision before ACK (post-commit ordering)", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(),
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);

  const initialRevision = instance.roomRevision;

  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES,
    data: {
      sources: ["audio", "camera"],
      operationId: "op-sources-1",
      expectedRoomRevision: initialRevision.toString(),
    },
  });

  const ackMsg = ws.messages.findLast(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.ok(ackMsg);
  assert.ok(ackMsg.data.accepted);

  // Revision should have been incremented before ACK sent
  const ackRevision = BigInt(ackMsg.data.roomRevision);
  assert.ok(
    ackRevision > initialRevision,
    "roomRevision should be incremented in ACK",
  );
});

test("Phase 1: error codes in OPERATION_ACK NACK follow contract (retryable boolean)", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio"]),
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);

  // Test STALE_CONNECTION_EPOCH NACK
  instance.participantConnectionEpochs.set("user-1:device-1", 3);
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
    data: {
      muted: true,
      deafened: false,
      operationId: "op-epoch",
      connectionEpoch: 1,
    },
  });

  let ackMsg = ws.messages.find(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.equal(ackMsg.data.code, "STALE_CONNECTION_EPOCH");
  assert.equal(ackMsg.data.retryable, true);
  assert.ok(ackMsg.data.connectionEpoch);

  // Test ROOM_REVISION_CONFLICT NACK
  instance.roomRevision = 10n;
  ws.messages.length = 0;
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
    data: {
      muted: true,
      deafened: false,
      operationId: "op-rev",
      expectedRoomRevision: "5",
    },
  });

  ackMsg = ws.messages.find(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.equal(ackMsg.data.code, "ROOM_REVISION_CONFLICT");
  assert.equal(ackMsg.data.retryable, true);
});

test("Phase 1: STALE_SOURCE_GENERATION rejected for replay of retired incarnation", async () => {
  const instance = createTestRoom();
  const ws = createMockWs();
  const session = createMockSession();

  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["audio"]),
    sourceStates: {
      audio: {
        generation: 5,
        desiredState: "active",
        publicationState: "published",
        provider: "sfu",
        updatedAt: Date.now(),
      },
    },
  });
  instance.isCurrentParticipantSession = () => true;
  instance.participantConnectionEpochs.set("user-1:device-1", 1);
  instance.roomRevision = 10n;
  instance.sourceRevision = 5n;

  console.log("TEST WS ID:", ws.id);
  console.log(
    "PARTICIPANT WS ID:",
    instance.participants.get("user-1:device-1")?.ws?.id,
  );

  // Client sends stale generation 3 (server has 5)
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES,
    data: {
      sources: ["audio"],
      sourceStates: {
        audio: { generation: 3, desiredState: "active" },
      },
      operationId: "test-stale-gen",
      expectedRoomRevision: "10",
      connectionEpoch: 1,
    },
  });

  const nackMsg = ws.messages.find(
    (m) => m.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
  );
  assert.ok(nackMsg);
  assert.equal(nackMsg.data.code, "STALE_SOURCE_GENERATION");
  assert.equal(nackMsg.data.retryable, false);
  assert.equal(nackMsg.data.expectedGeneration, 5);
  assert.equal(nackMsg.data.receivedGeneration, 3);
  assert.ok(nackMsg.data.canonicalState);
});
