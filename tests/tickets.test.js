import assert from "node:assert/strict";
import test, { before } from "node:test";
import {
  SignJWT,
  decodeJwt,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
} from "jose";
import { MEDIA_CONTROL_MESSAGE_TYPES } from "../src/protocol.js";
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
  const mod = await import("../src/tickets.js");
  assert.ok(typeof mod.verifyMediaTicket === "function");
  assert.ok(typeof mod.signProviderTicket === "function");
  assert.ok(typeof mod.getMediaVerifyKey === "function");
  assert.ok(typeof mod.getProviderSigningKey === "function");
});

test("verifies a valid media ticket from raw PEM and base64 keys", async () => {
  const token = await mediaToken();
  const raw = await import("../src/tickets.js?raw-key-test");
  const encoded = await import("../src/tickets.js?base64-key-test");
  const rawClaims = await raw.verifyMediaTicket(token, env());
  const encodedClaims = await encoded.verifyMediaTicket(
    token,
    env(Buffer.from(publicPem).toString("base64")),
  );

  assert.equal(rawClaims.sub, "user-1");
  assert.equal(encodedClaims.channelId, "channel-1");
});

test("rejects expired, misissued, misaudienced, and altered media tickets", async () => {
  const mod = await import("../src/tickets.js?security-test");
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
  const mod = await import("../src/tickets.js?wrong-key-test");

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
      contractRevision: 2,
      mediaSessionId: "media-session-1",
    },
  });

  assert.equal(ws.closeCode, 4003);
  assert.equal(room.participants.size, 0);
  assert.equal(messages.at(-1).data.error, "Media ticket channel mismatch");
});

test("signs provider tickets with the configured TTL", async () => {
  const mod = await import("../src/tickets.js?provider-ticket-test");
  const token = await mod.signProviderTicket(
    { iss: issuer, aud: "dspeak-sfu", sub: "user-1" },
    env(),
  );
  const claims = decodeJwt(token);

  assert.equal(claims.iss, issuer);
  assert.equal(claims.aud, "dspeak-sfu");
  assert.equal(claims.exp - claims.iat, 30);
});
