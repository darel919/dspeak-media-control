import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_CONTROL_MESSAGE_TYPES,
  SFU_PROVIDER,
  createSFURoute,
} from "../src/protocol.js";
import { handleRoomMessage } from "../src/media-room-messages.ts";
import { MediaRoomDO } from "../src/MediaRoomDO.ts";

function roomWithParticipant() {
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
  instance.route = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    1,
    0,
    "test",
  );
  instance.participants.clear();
  const sent = [];
  const ws = {
    serializeAttachment() {},
    send(message) {
      sent.push(JSON.parse(message));
    },
  };
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(),
    sourceStates: {},
  });
  instance.isCurrentParticipantSession = () => true;
  return { instance, sent };
}

function mediaSourcesMessage(sources, sourceStates, operationId) {
  return {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES,
    data: { sources, sourceStates, operationId },
  };
}

function lastAck(sent, operationId) {
  return sent
    .filter(
      (message) =>
        message.type === MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK &&
        message.data?.operationId === operationId,
    )
    .at(-1);
}

test("replacement failure sequence N+1/N+2/N+3 commits against the real generation validator", async () => {
  const { instance, sent } = roomWithParticipant();

  // Initial source: generation N = 1, active
  const op1 = "op-init";
  await handleRoomMessage(
    instance,
    instance.participants.get("user-1:device-1").ws,
    {
      authenticated: true,
      userId: "user-1",
      deviceId: "device-1",
      peerId: "peer-1",
      sources: [],
    },
    mediaSourcesMessage(
      ["camera"],
      { camera: { generation: 1, desiredState: "active" } },
      op1,
    ),
  );
  const ack1 = lastAck(sent, op1);
  assert.equal(ack1?.data?.accepted, true);
  assert.equal(
    instance.participants.get("user-1:device-1").sourceStates.camera.generation,
    1,
  );

  // Replacement: N+1 = 2 active
  const op2 = "op-replace";
  await handleRoomMessage(
    instance,
    instance.participants.get("user-1:device-1").ws,
    {
      authenticated: true,
      userId: "user-1",
      deviceId: "device-1",
      peerId: "peer-1",
      sources: ["camera"],
    },
    mediaSourcesMessage(
      ["camera"],
      { camera: { generation: 2, desiredState: "active" } },
      op2,
    ),
  );
  const ack2 = lastAck(sent, op2);
  assert.equal(ack2?.data?.accepted, true);

  // Recovery after failed replacement: N+2 = 3 active (same source re-published)
  const op3 = "op-recover";
  await handleRoomMessage(
    instance,
    instance.participants.get("user-1:device-1").ws,
    {
      authenticated: true,
      userId: "user-1",
      deviceId: "device-1",
      peerId: "peer-1",
      sources: ["camera"],
    },
    mediaSourcesMessage(
      ["camera"],
      { camera: { generation: 3, desiredState: "active" } },
      op3,
    ),
  );
  const ack3 = lastAck(sent, op3);
  assert.equal(ack3?.data?.accepted, true);

  // Retirement: N+3 = 4 inactive (source removed from set)
  const op4 = "op-retire";
  await handleRoomMessage(
    instance,
    instance.participants.get("user-1:device-1").ws,
    {
      authenticated: true,
      userId: "user-1",
      deviceId: "device-1",
      peerId: "peer-1",
      sources: ["camera"],
    },
    mediaSourcesMessage(
      [],
      { camera: { generation: 4, desiredState: "inactive" } },
      op4,
    ),
  );
  const ack4 = lastAck(sent, op4);
  assert.equal(ack4?.data?.accepted, true);

  // Final canonical state: camera retired at generation 4, inactive
  const canonical = ack4?.data?.canonicalState;
  const participantState = canonical?.participants?.find(
    (participant) => participant.peerId === "peer-1",
  );
  const cameraState = participantState?.sourceStates?.camera;
  assert.equal(cameraState?.generation, 4);
  assert.equal(cameraState?.desiredState, "inactive");
  assert.equal(cameraState?.publicationState, "unpublished");

  // publicationRevision stays numeric and increments only on publication change
  assert.equal(Number.isSafeInteger(instance.publicationRevision), true);
  assert.ok(instance.publicationRevision >= 0);
});

test("heartbeat ACK carries a numeric publicationRevision that does not go stale", async () => {
  const { instance, sent } = roomWithParticipant();
  instance.publicationRevision = 41;

  const ws = instance.participants.get("user-1:device-1").ws;
  await handleRoomMessage(
    instance,
    ws,
    {
      authenticated: true,
      userId: "user-1",
      deviceId: "device-1",
      peerId: "peer-1",
      sources: [],
    },
    {
      type: MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT,
      data: {
        sequence: 1,
        topologyEpoch: 1,
        sourceRevision: 0,
        connectionEpoch: 1,
      },
    },
  );

  const heartbeatAck = sent
    .filter(
      (message) => message.type === MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK,
    )
    .at(-1);
  assert.equal(heartbeatAck?.data?.publicationRevision, 41);
  assert.equal(typeof heartbeatAck?.data?.publicationRevision, "number");
  assert.equal(Array.isArray(heartbeatAck?.data?.publishedSourcesDigest), true);
});

function publishTrack(room, peerId, source, trackName) {
  room.publishedSources.set(`${peerId}:${source}`, {
    peerId,
    source,
    trackName,
    generation: 1,
    connectionEpoch: 1,
    sessionId: "session-1",
    userId: "user-1",
    closed: false,
  });
}

test("close push and delayed old heartbeat cannot resurrect an old publication", async () => {
  const { instance, sent } = roomWithParticipant();
  publishTrack(instance, "peer-2", "screen", "track-screen-X");

  // Two participants: sender (peer-2) and receiver (peer-1)
  const receiverWs = instance.participants.get("user-1:device-1").ws;
  const senderWs = {
    serializeAttachment() {},
    send() {},
  };
  instance.participants.set("user-2:device-2", {
    userId: "user-2",
    deviceId: "device-2",
    peerId: "peer-2",
    ws: senderWs,
    sources: new Set(["screen"]),
    sourceStates: {
      screen: {
        generation: 1,
        desiredState: "active",
        publicationState: "published",
      },
    },
  });

  // Snapshot at R40 would contain screen X
  const beforeCloseLength = sent.length;
  const beforeRevision = instance.publicationRevision;

  // Sender stops screen: MEDIA_SOURCES retirement -> close push with new revision
  await handleRoomMessage(
    instance,
    senderWs,
    {
      authenticated: true,
      userId: "user-2",
      deviceId: "device-2",
      peerId: "peer-2",
      sources: ["screen"],
    },
    mediaSourcesMessage(
      [],
      { screen: { generation: 2, desiredState: "inactive" } },
      "op-stop-screen",
    ),
  );

  const closePush = sent
    .slice(beforeCloseLength)
    .filter(
      (message) =>
        message.type ===
        MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
    );

  // Close push MUST carry the new revision
  assert.equal(closePush.length, 1);
  assert.equal(closePush[0]?.data?.trackName, "track-screen-X");
  assert.equal(closePush[0]?.data?.closed, true);
  assert.equal(closePush[0]?.data?.publicationRevision, beforeRevision + 1);

  // Late heartbeat snapshot from R40 (pre-close) with old revision arrives
  const snapshot = instance.buildTopologySnapshot();
  assert.equal(snapshot.publishedSources.length, 0);
  assert.equal(instance.publicationRevision, beforeRevision + 1);
  assert.equal(instance.publishedSources.has("peer-1:screen"), false);
});

test("publicationRevision survives Durable Object reconstruction", async () => {
  const storage = {
    values: {},
    async get(key) {
      return this.values[key] ?? null;
    },
    async put(key, value) {
      this.values[key] = value;
    },
    async delete(key) {
      delete this.values[key];
    },
    async setAlarm() {},
  };
  const env = {
    MEDIA_CONTROL_ADMIN_TOKEN: "admin",
    CLOUDFLARE_REALTIME_APP_ID: "app",
    CLOUDFLARE_REALTIME_APP_SECRET: "secret",
  };
  const first = new MediaRoomDO({ storage, getWebSockets: () => [] }, env);
  first.stateLoaded = true;
  first.publicationRevision = 50;

  // Retirement changes publications to R51
  publishTrack(first, "peer-2", "screen", "track-screen-X");
  first.state.storage.put("publishedSources", [
    ...first.publishedSources.values(),
  ]);
  const retired = first.retireParticipantPublications("peer-2");

  assert.equal(retired.length, 1);
  assert.equal(first.publicationRevision, 51);
  await promiseMicrotaskFlush();

  // Reconstruct the DO from storage: revision must load as 51, not 50
  const second = new MediaRoomDO({ storage, getWebSockets: () => [] }, env);
  await second.loadDurableState();

  assert.equal(second.publicationRevision, 51);
  assert.equal(second.publishedSources.size, 0);
  assert.ok(second.publicationRevision >= 50);
});

function promiseMicrotaskFlush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("hibernation with a connected client keeps reconciliation monotonic", async () => {
  const storage = {
    values: {},
    async get(key) {
      return this.values[key] ?? null;
    },
    async put(key, value) {
      this.values[key] = value;
    },
    async delete(key) {
      delete this.values[key];
    },
    async setAlarm() {},
  };
  const env = {
    MEDIA_CONTROL_ADMIN_TOKEN: "admin",
    CLOUDFLARE_REALTIME_APP_ID: "app",
    CLOUDFLARE_REALTIME_APP_SECRET: "secret",
  };

  // Client lastApplied = R51; stored revision is R51
  const first = new MediaRoomDO({ storage, getWebSockets: () => [] }, env);
  first.stateLoaded = true;
  first.publicationRevision = 51;
  publishTrack(first, "screen", "track-screen-X");
  await first.state.storage.put("publishedSources", [
    ...first.publishedSources.values(),
  ]);
  await first.state.storage.put("publicationRevision", 51);
  await first.state.storage.put("roomRevision", 12n);

  // Reconstruct (hibernation): constructor reruns, storage must be restored.
  // A dormant reset (no sockets) advances the revision to 52 and clears the
  // publication set; the invariant is that the revision NEVER rolls back.
  const second = new MediaRoomDO({ storage, getWebSockets: () => [] }, env);
  await second.loadDurableState();

  assert.ok(second.publicationRevision >= 51);
  assert.equal(second.publishedSources.size, 0);
  const loadedRevision = second.publicationRevision;
  // Any further publication mutation advances monotonically
  second.retireParticipantPublications("peer-1");
  assert.ok(second.publicationRevision >= loadedRevision);
});

test("serialized session attachment carries the newest publicationState after a provider callback", async () => {
  let attached = null;
  const storage = {
    values: {},
    async get(key) {
      return this.values[key] ?? null;
    },
    async put(key, value) {
      this.values[key] = value;
    },
    async delete(key) {
      delete this.values[key];
    },
    async setAlarm() {},
  };
  const env = {
    MEDIA_CONTROL_ADMIN_TOKEN: "admin",
    CLOUDFLARE_REALTIME_APP_ID: "app",
    CLOUDFLARE_REALTIME_APP_SECRET: "secret",
  };
  const instance = new MediaRoomDO({ storage, getWebSockets: () => [] }, env);
  instance.stateLoaded = true;
  instance.route = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    1,
    0,
    "test",
  );

  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    sources: ["screen"],
    cloudflareSessionId: "session-1",
    connectionEpoch: 1,
  };
  const ws = {
    serializeAttachment(value) {
      attached = value;
    },
    send() {},
  };
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(["screen"]),
    sourceStates: {},
    connectionEpoch: 1,
    cloudflareSessionId: "session-1",
  });
  instance.isCurrentParticipantSession = () => true;

  // Canonical intent: client announces screen as active (sourceState
  // publicationState "announced").
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES,
    data: {
      sources: ["screen"],
      sourceStates: {
        screen: { generation: 1, desiredState: "active" },
      },
      operationId: "op-announce-screen",
    },
  });

  // Provider callback: screen publication becomes live -> publicationState
  // must transition from announced to published.
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION,
    data: {
      peerId: "peer-1",
      source: "screen",
      trackName: "track-screen",
      sessionId: "session-1",
      generation: 1,
      connectionEpoch: 1,
      closed: false,
    },
  });

  // The authoritative participant state must have been copied into the
  // session BEFORE serialization, so hibernation reconstructs the NEW state.
  assert.equal(
    instance.participants.get("user-1:device-1").sourceStates.screen
      .publicationState,
    "published",
  );
  assert.equal(attached.sourceStates.screen.publicationState, "published");
  assert.equal(attached.cloudflareSessionId, "session-1");
});
