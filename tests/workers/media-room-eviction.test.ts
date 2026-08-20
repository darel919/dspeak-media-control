import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MEDIA_CONTROL_CLIENT_HELLO,
  MEDIA_CONTROL_MESSAGE_TYPES,
} from "../../src/protocol.ts";

const operationId = "eviction-media-sources";
const participantKey = "user-1:device-1";
const channelId = "channel-1";

let mediaPrivateKey;
let mediaPublicPem;

beforeAll(async () => {
  const keyPair = await generateKeyPair("EdDSA");
  mediaPrivateKey = keyPair.privateKey;
  mediaPublicPem = await exportSPKI(keyPair.publicKey);
});

async function mediaToken() {
  return new SignJWT({
    sub: "user-1",
    deviceId: "device-1",
    channelId,
    connectionMode: "auto",
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer("dspeak-media-control")
    .setAudience("dspeak-media-control")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(mediaPrivateKey);
}

async function openRoomSocket(stub) {
  const response = await stub.fetch(
    `https://media.example/media-control/${channelId}`,
    {
      headers: {
        Upgrade: "websocket",
        "X-dSpeak-Channel-Id": channelId,
      },
    },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected a WebSocket response");
  socket.accept();
  return socket;
}

async function authenticateRoom(stub, socket) {
  return runInDurableObject(stub, async (instance, state) => {
    instance.env.MEDIA_TICKET_PUBLIC_KEY = mediaPublicPem;
    const serverSocket = state.getWebSockets()[0];
    if (!serverSocket) throw new Error("Expected an attached server WebSocket");
    const session = instance.getSession(serverSocket);
    await instance.handleMessage(serverSocket, session, {
      type: MEDIA_CONTROL_CLIENT_HELLO,
      data: {
        ticket: await mediaToken(),
        protocolVersion: 919,
        contractRevision: 5,
        mediaSessionId: session.mediaSessionId,
      },
    });
    return {
      connectionEpoch: session.connectionEpoch,
      peerId: session.peerId,
    };
  });
}

function mediaSourcesMessage(epoch, id = operationId) {
  return {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES,
    data: {
      sources: ["audio"],
      operationId: id,
      connectionEpoch: epoch,
      sourceStates: {
        audio: { generation: 1, desiredState: "active" },
      },
    },
  };
}

async function commitMediaSources(stub, epoch, id = operationId) {
  return runInDurableObject(stub, async (instance, state) => {
    const serverSocket = state.getWebSockets()[0];
    if (!serverSocket) throw new Error("Expected an attached server WebSocket");
    const session = instance.getSession(serverSocket);
    await instance.handleMessage(
      serverSocket,
      session,
      mediaSourcesMessage(epoch, id),
    );
    const key = `${participantKey}:${epoch}:${id}`;
    return {
      result: instance.operationResults.get(key),
      roomRevision: instance.roomRevision.toString(),
      sourceRevision: instance.sourceRevision,
      publicationRevision: instance.publicationRevision,
      sourceState:
        instance.participants.get(participantKey)?.sourceStates?.audio,
    };
  });
}

describe("MediaRoomDO Durable Object reconstruction", () => {
  it("reconstructs a hibernated session and replays its committed operation", async () => {
    const id = env.MEDIA_ROOM_DO.idFromName(
      `round3-eviction-${crypto.randomUUID()}`,
    );
    const stub = env.MEDIA_ROOM_DO.get(id);
    const socket = await openRoomSocket(stub);
    const firstSession = await authenticateRoom(stub, socket);
    expect(firstSession.connectionEpoch).toBe(1);

    const first = await commitMediaSources(stub, firstSession.connectionEpoch);
    expect(first.result?.accepted).toBe(true);
    expect(first.sourceRevision).toBeGreaterThan(0);
    expect(BigInt(first.roomRevision)).toBeGreaterThan(0n);
    expect(first.sourceState).toMatchObject({
      generation: 1,
      desiredState: "active",
    });

    await evictDurableObject(stub);

    const replay = await runInDurableObject(stub, async (instance, state) => {
      const serverSocket = state.getWebSockets()[0];
      if (!serverSocket) throw new Error("Expected the hibernated WebSocket");
      const session = instance.getSession(serverSocket);
      const key = `${participantKey}:${session.connectionEpoch}:${operationId}`;
      expect(instance.operationResults.has(key)).toBe(true);
      const before = {
        roomRevision: instance.roomRevision.toString(),
        sourceRevision: instance.sourceRevision,
        publicationRevision: instance.publicationRevision,
      };
      await instance.handleMessage(
        serverSocket,
        session,
        mediaSourcesMessage(session.connectionEpoch),
      );
      return {
        before,
        after: {
          roomRevision: instance.roomRevision.toString(),
          sourceRevision: instance.sourceRevision,
          publicationRevision: instance.publicationRevision,
        },
        connectionEpoch: session.connectionEpoch,
        sourceState:
          instance.participants.get(participantKey)?.sourceStates?.audio,
      };
    });

    expect(replay.connectionEpoch).toBe(1);
    expect(replay.sourceState).toMatchObject({
      generation: 1,
      desiredState: "active",
    });
    expect(replay.after).toEqual(replay.before);
    socket.close(1000, "done");
  });

  it("resets stale room topology before a closed-socket reconnect advances epoch", async () => {
    const id = env.MEDIA_ROOM_DO.idFromName(
      `round3-closed-${crypto.randomUUID()}`,
    );
    const stub = env.MEDIA_ROOM_DO.get(id);
    const socket = await openRoomSocket(stub);
    const firstSession = await authenticateRoom(stub, socket);
    const initial = await commitMediaSources(
      stub,
      firstSession.connectionEpoch,
    );

    await runInDurableObject(stub, async (instance, state) => {
      const serverSocket = state.getWebSockets()[0];
      if (!serverSocket)
        throw new Error("Expected an attached server WebSocket");
      const session = instance.getSession(serverSocket);
      const participant = instance.participants.get(participantKey);
      if (!participant)
        throw new Error("Expected the authenticated participant");
      session.cloudflareSessionId = "cloudflare-session-1";
      participant.cloudflareSessionId = session.cloudflareSessionId;
      serverSocket.serializeAttachment(session);
      await instance.handleMessage(serverSocket, session, {
        type: MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION,
        data: {
          source: "audio",
          trackName: "audio-track-1",
          generation: 1,
          connectionEpoch: firstSession.connectionEpoch,
        },
      });
      await instance.commitRoute({
        kind: "sfu",
        provider: "cloudflare-realtime",
        epoch: instance.epoch + 1,
        sourceRevision: instance.sourceRevision,
        reason: "test-active-route",
      });
      expect(instance.publishedSources.size).toBe(1);
      expect(instance.route.kind).toBe("sfu");
    });

    await evictDurableObject(stub, { webSockets: "close" });
    const reconnectedSocket = await openRoomSocket(stub);
    const reconnected = await authenticateRoom(stub, reconnectedSocket);
    expect(reconnected.connectionEpoch).toBe(2);

    const afterReset = await runInDurableObject(stub, async (instance) => ({
      routeKind: instance.route.kind,
      pendingRoute: instance.pendingRoute,
      publishedSources: instance.publishedSources.size,
      providerHealth: instance.providerHealth.size,
      operationResults: instance.operationResults.size,
      participantSources: [
        ...(instance.participants.get(participantKey)?.sources || []),
      ],
      roomRevision: instance.roomRevision.toString(),
      sourceRevision: instance.sourceRevision,
      publicationRevision: instance.publicationRevision,
    }));

    expect(afterReset.routeKind).toBe("local");
    expect(afterReset.pendingRoute).toBeNull();
    expect(afterReset.publishedSources).toBe(0);
    expect(afterReset.providerHealth).toBe(0);
    expect(afterReset.operationResults).toBeGreaterThan(0);
    expect(afterReset.participantSources).toEqual([]);
    expect(BigInt(afterReset.roomRevision)).toBeGreaterThan(
      BigInt(initial.roomRevision),
    );
    expect(afterReset.sourceRevision).toBeGreaterThan(initial.sourceRevision);
    expect(afterReset.publicationRevision).toBeGreaterThan(
      initial.publicationRevision,
    );

    const newEpochOperation = await commitMediaSources(
      stub,
      reconnected.connectionEpoch,
    );
    expect(newEpochOperation.result?.accepted).toBe(true);
    expect(newEpochOperation.result?.replayed).toBeUndefined();
    reconnectedSocket.close(1000, "done");
  });
});
