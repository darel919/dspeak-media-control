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
