import assert from "node:assert/strict";
import test, { before } from "node:test";
import {
  SignJWT,
  decodeJwt,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
} from "jose";
import { MEDIA_CONTROL_MESSAGE_TYPES } from "../src/protocol.ts";
import { MediaRoomDO } from "../src/MediaRoomDO.ts";

let privateKey;
let publicPem;
let privatePem;
const issuer = "dspeak-media-control";

before(async () => {
  const keyPair = await generateKeyPair("EdDSA");
  privateKey = keyPair.privateKey;
  publicPem = await exportSPKI(keyPair.publicKey);
  privatePem = await exportPKCS8(privateKey);
});

function env(publicKey = publicPem, providerKey = privatePem) {
  return {
    MEDIA_TICKET_PUBLIC_KEY: publicKey,
    PROVIDER_TICKET_PRIVATE_KEY: providerKey,
    MEDIA_CONTROL_ISSUER: issuer,
    PROVIDER_TICKET_TTL_SECONDS: "30",
  };
}

function capacityRoom() {
  const storage = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    setAlarm: async () => {},
  };
  const room = new MediaRoomDO({ storage, getWebSockets: () => [] }, env());
  room.stateLoaded = true;
  room.channelId = "channel-1";
  room.commitRoute = () => {};
  room.sendTopology = () => {};
  room.broadcastTopology = () => {};
  room.maybeStartQualification = () => {};
  room.refreshPendingRouteSourceRevision = async () => {};
  return room;
}

function capacitySocket() {
  return {
    messages: [],
    attachment: null,
    closeCode: null,
    send(message) {
      this.messages.push(JSON.parse(message));
    },
    close(code, reason) {
      this.closeCode = { code, reason };
      if (this.throwOnClose) throw new Error("close failed");
    },
    serializeAttachment(value) {
      this.attachment = value;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

async function authenticateParticipant(room, index, connectionMode) {
  const ws = capacitySocket();
  const mediaSessionId = `media-session-${index}`;
  const session = {
    authenticated: false,
    mediaSessionId,
    peerId: `peer-${index}`,
  };
  room.sessions.set(ws, session);
  await room.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.HELLO,
    data: {
      ticket: await mediaToken({
        sub: `user-${index}`,
        deviceId: `device-${index}`,
        connectionMode,
      }),
      protocolVersion: 919,
      contractRevision: 5,
      mediaSessionId,
    },
  });
  return { session, ws };
}

test("genuine participant reconnects advance the server-owned connection epoch", async () => {
  const room = capacityRoom();
  const first = await authenticateParticipant(room, 1, "auto");
  const second = await authenticateParticipant(room, 1, "auto");

  assert.equal(first.session.connectionEpoch, 1);
  assert.equal(second.session.connectionEpoch, 2);
  assert.deepEqual(first.ws.closeCode, {
    code: 4000,
    reason: "Media session superseded",
  });
  assert.equal(room.participants.size, 1);
});

test("same-WebSocket hibernation restoration keeps the connection epoch", async () => {
  const room = capacityRoom();
  const first = await authenticateParticipant(room, 1, "auto");
  room.sessions.delete(first.ws);

  const restored = room.getSession(first.ws);

  assert.equal(restored.connectionEpoch, first.session.connectionEpoch);
  assert.equal(room.participantConnectionEpochs.get("user-1:device-1"), 1);
  assert.equal(room.participants.get("user-1:device-1").ws, first.ws);
});

test("hibernated restoration fences an older attachment behind the canonical epoch", async () => {
  const room = capacityRoom();
  const staleWs = capacitySocket();
  const currentWs = capacitySocket();
  const participantKey = "user-1:device-1";
  staleWs.attachment = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    channelId: "channel-1",
    peerId: "peer-1",
    connectionEpoch: 1,
    sources: [],
    sourceStates: {},
  };
  currentWs.attachment = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    channelId: "channel-1",
    peerId: "peer-2",
    connectionEpoch: 2,
    sources: [],
    sourceStates: {},
  };
  room.stateLoaded = false;
  room.state.storage.get = async (key) =>
    key === "participantConnectionEpochs" ? { [participantKey]: 2 } : null;
  room.state.getWebSockets = () => [staleWs, currentWs];

  await room.loadDurableState();
  const staleSession = room.sessions.get(staleWs);
  const currentSession = room.sessions.get(currentWs);

  assert.equal(staleSession.connectionEpoch, 1);
  assert.equal(currentSession.connectionEpoch, 2);
  assert.equal(room.participants.get(participantKey).ws, currentWs);
  assert.equal(room.participants.get(participantKey).connectionEpoch, 2);
  assert.equal(room.isCurrentParticipantSession(staleWs, staleSession), false);
  assert.equal(
    room.isCurrentParticipantSession(currentWs, currentSession),
    true,
  );

  room.webSocketClose(staleWs, 4000, "superseded", true);

  assert.equal(room.participants.get(participantKey).ws, currentWs);
  assert.equal(
    room.isCurrentParticipantSession(currentWs, currentSession),
    true,
  );
});

test("webSocketClose cleans up the participant and completes the close handshake", () => {
  const room = capacityRoom();
  const ws = capacitySocket();
  const participantKey = "user-1:device-1";
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    connectionEpoch: 1,
  };
  room.sessions.set(ws, session);
  room.participantConnectionEpochs.set(participantKey, 1);
  room.participants.set(participantKey, {
    ...session,
    ws,
    status: "connected",
  });

  room.webSocketClose(ws, 1000, "client closed", true);

  assert.equal(room.sessions.has(ws), false);
  assert.equal(room.participants.get(participantKey).ws, null);
  assert.deepEqual(ws.closeCode, { code: 1000, reason: "client closed" });
});

test("webSocketClose keeps cleanup when the close reply throws", () => {
  const room = capacityRoom();
  const ws = capacitySocket();
  const participantKey = "user-1:device-1";
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    connectionEpoch: 1,
  };
  ws.throwOnClose = true;
  room.sessions.set(ws, session);
  room.participantConnectionEpochs.set(participantKey, 1);
  room.participants.set(participantKey, {
    ...session,
    ws,
    status: "connected",
  });

  assert.doesNotThrow(() =>
    room.webSocketClose(ws, 1006, "network error", false),
  );
  assert.equal(room.sessions.has(ws), false);
  assert.equal(room.participants.get(participantKey).ws, null);
});

function baseClaims() {
  return {
    sub: "user-1",
    deviceId: "device-1",
    channelId: "channel-1",
    connectionMode: "auto",
  };
}

async function mediaToken(overrides = {}, options = {}) {
  const claims = { ...baseClaims(), ...overrides };
  for (const key of Object.keys(claims))
    if (claims[key] === undefined) delete claims[key];
  const token = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(options.issuer || issuer)
    .setAudience(options.audience || "dspeak-media-control")
    .setIssuedAt();
  token.setExpirationTime(options.expiration || "2m");
  return token.sign(options.key || privateKey);
}

test("exports ticket functions", async () => {
  const mod = await import("../src/tickets.ts");
  assert.ok(typeof mod.verifyMediaTicket === "function");
  assert.ok(typeof mod.signProviderTicket === "function");
  assert.ok(typeof mod.getMediaVerifyKey === "function");
  assert.ok(typeof mod.getProviderSigningKey === "function");
});

test("verifies a valid media ticket from raw PEM and base64 keys", async () => {
  const token = await mediaToken();
  const raw = await import("../src/tickets.ts?raw-key-test");
  const encoded = await import("../src/tickets.ts?base64-key-test");
  const rawClaims = await raw.verifyMediaTicket(token, env());
  const encodedClaims = await encoded.verifyMediaTicket(
    token,
    env(Buffer.from(publicPem).toString("base64")),
  );

  assert.equal(rawClaims.sub, "user-1");
  assert.equal(encodedClaims.channelId, "channel-1");
});

test("rejects expired, misissued, misaudienced, and altered media tickets", async () => {
  const mod = await import("../src/tickets.ts?security-test");
  const expired = await mediaToken(
    {},
    { expiration: Math.floor(Date.now() / 1000) - 10 },
  );
  const wrongIssuer = await mediaToken({}, { issuer: "attacker" });
  const wrongAudience = await mediaToken({}, { audience: "other-service" });
  const valid = await mediaToken();
  const [header, payload, signature] = valid.split(".");
  const altered = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

  await assert.rejects(() => mod.verifyMediaTicket(expired, env()));
  await assert.rejects(() => mod.verifyMediaTicket(wrongIssuer, env()));
  await assert.rejects(() => mod.verifyMediaTicket(wrongAudience, env()));
  await assert.rejects(() => mod.verifyMediaTicket(altered, env()));
});

test("rejects a media ticket signed by a different key", async () => {
  const wrongKeyPair = await generateKeyPair("EdDSA");
  const token = await mediaToken({}, { key: wrongKeyPair.privateKey });
  const mod = await import("../src/tickets.ts?wrong-key-test");

  await assert.rejects(() => mod.verifyMediaTicket(token, env()));
});

test("requires identity claims and a valid connection mode", async () => {
  const { verifyRoomTicket } = await import("../src/media-room-messages.ts");
  const room = { env: env() };
  const missingDevice = await mediaToken({ deviceId: undefined });
  const invalidMode = await mediaToken({ connectionMode: "relay" });

  const missingDeviceResult = await verifyRoomTicket(room, missingDevice);
  assert.equal(missingDeviceResult.valid, false);
  assert.match(missingDeviceResult.error, /deviceId/);
  assert.deepEqual(await verifyRoomTicket(room, invalidMode), {
    valid: false,
    error: "Media ticket has an invalid connection mode",
  });
});

test("rejects a valid ticket for a different channel during room authentication", async () => {
  const messages = [];
  const storage = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  };
  const room = new MediaRoomDO({ storage, getWebSockets: () => [] }, env());
  room.stateLoaded = true;
  room.channelId = "expected-channel";
  const ws = {
    send(message) {
      messages.push(JSON.parse(message));
    },
    closeCode: null,
    close(code) {
      this.closeCode = code;
    },
    serializeAttachment() {},
  };
  const session = {
    authenticated: false,
    mediaSessionId: "media-session-1",
    peerId: "peer-1",
  };

  await room.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.HELLO,
    data: {
      ticket: await mediaToken({ channelId: "other-channel" }),
      protocolVersion: 919,
      contractRevision: 5,
      mediaSessionId: "media-session-1",
    },
  });

  assert.equal(ws.closeCode, 4003);
  assert.equal(room.participants.size, 0);
  assert.equal(messages.at(-1).data.error, "Media ticket channel mismatch");
});

test("enforces direct audio/video and auto channel participant ceilings", async () => {
  const directAudioRoom = capacityRoom();
  for (let index = 1; index <= 8; index++)
    await authenticateParticipant(directAudioRoom, index, "direct");
  const directAudioNinth = await authenticateParticipant(
    directAudioRoom,
    9,
    "direct",
  );
  assert.equal(directAudioRoom.participants.size, 8);
  assert.equal(
    directAudioNinth.ws.messages.at(-1).data.code,
    "MEDIA_CHANNEL_PARTICIPANT_LIMIT_EXCEEDED",
  );
  assert.equal(directAudioNinth.ws.closeCode.code, 4004);

  const directVideoRoom = capacityRoom();
  const firstVideoParticipant = await authenticateParticipant(
    directVideoRoom,
    1,
    "direct",
  );
  await directVideoRoom.handleMessage(
    firstVideoParticipant.ws,
    firstVideoParticipant.session,
    {
      type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES,
      data: {
        sources: ["microphone", "camera"],
        sourceStates: {
          microphone: { generation: 1, desiredState: "active" },
          camera: { generation: 1, desiredState: "active" },
        },
        operationId: "op-video-1",
      },
    },
  );
  for (let index = 2; index <= 4; index++)
    await authenticateParticipant(directVideoRoom, index, "direct");
  const directVideoFifth = await authenticateParticipant(
    directVideoRoom,
    5,
    "direct",
  );
  assert.equal(directVideoRoom.participants.size, 4);
  assert.equal(
    directVideoFifth.ws.messages.at(-1).data.code,
    "MEDIA_CHANNEL_PARTICIPANT_LIMIT_EXCEEDED",
  );
  assert.equal(directVideoFifth.ws.closeCode.code, 4004);

  const autoRoom = capacityRoom();
  for (let index = 1; index <= 100; index++)
    await authenticateParticipant(autoRoom, index, "auto");
  const autoOneHundredFirst = await authenticateParticipant(
    autoRoom,
    101,
    "auto",
  );
  assert.equal(autoRoom.participants.size, 100);
  assert.equal(
    autoOneHundredFirst.ws.messages.at(-1).data.code,
    "MEDIA_CHANNEL_PARTICIPANT_LIMIT_EXCEEDED",
  );
  assert.equal(autoOneHundredFirst.ws.closeCode.code, 4004);
});

test("signs provider tickets with the configured TTL", async () => {
  const mod = await import("../src/tickets.ts?provider-ticket-test");
  const token = await mod.signProviderTicket(
    { iss: issuer, aud: "dspeak-sfu", sub: "user-1" },
    env(),
  );
  const claims = decodeJwt(token);

  assert.equal(claims.iss, issuer);
  assert.equal(claims.aud, "dspeak-sfu");
  assert.equal(claims.exp - claims.iat, 30);
});
