import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const operationId = "eviction-media-sources";
const participantKey = "user-1:device-1";

function createWs() {
  const messages: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    readyState: 1,
    messages,
    serializeAttachment() {},
    send(value: string) {
      messages.push(JSON.parse(value));
    },
    close() {},
    deserializeAttachment() {
      return null;
    },
  };
}

function createSession(connectionEpoch: number) {
  return {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    connectionMode: "auto",
    connectionEpoch,
    mediaSessionId: "session-1",
  };
}

function createParticipant(connectionEpoch: number, active = false) {
  return {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws: null,
    sources: new Set<string>(active ? ["audio"] : []),
    sourceStates: {
      audio: {
        generation: active ? 1 : 0,
        desiredState: active ? "active" : "inactive",
        publicationState: active ? "announced" : "unpublished",
        provider: null,
      },
    },
    connectionEpoch,
  };
}

describe("MediaRoomDO Durable Object reconstruction", () => {
  it("replays a committed MEDIA_SOURCES operation after real eviction", async () => {
    const id = env.MEDIA_ROOM_DO.idFromName(
      `round3-eviction-${crypto.randomUUID()}`,
    );
    const stub = env.MEDIA_ROOM_DO.get(id);
    const message = {
      type: "media-sources",
      data: {
        sources: ["audio"],
        operationId,
        connectionEpoch: 1,
        sourceStates: {
          audio: { generation: 1, desiredState: "active" },
        },
      },
    };

    const first = await runInDurableObject(stub, async (instance) => {
      instance.stateLoaded = true;
      instance.participants.set(participantKey, createParticipant(1));
      instance.participantConnectionEpochs.set(participantKey, 1);
      instance.isCurrentParticipantSession = () => true;
      const ws = createWs();
      await instance.handleMessage(ws, createSession(1), message);
      const ack = ws.messages.at(-1);
      return {
        ack,
        roomRevision: instance.roomRevision.toString(),
        sourceRevision: instance.sourceRevision,
        publicationRevision: instance.publicationRevision,
        publishedSources: instance.publishedSources.size,
        sourceState:
          instance.participants.get(participantKey)?.sourceStates?.audio,
      };
    });

    expect(first.ack?.type).toBe("operation-ack");
    expect(first.ack?.data.accepted).toBe(true);
    expect(first.sourceRevision).toBeGreaterThan(0);
    expect(BigInt(first.roomRevision)).toBeGreaterThan(0n);
    expect(first.sourceState).toMatchObject({
      generation: 1,
      desiredState: "active",
    });
    await evictDurableObject(stub, { webSockets: "close" });

    const replay = await runInDurableObject(stub, async (instance) => {
      instance.isCurrentParticipantSession = () => true;
      const ws = createWs();
      await instance.handleMessage(ws, createSession(1), message);
      const ack = ws.messages.at(-1);
      return {
        ack,
        roomRevision: instance.roomRevision.toString(),
        sourceRevision: instance.sourceRevision,
        publicationRevision: instance.publicationRevision,
        publishedSources: instance.publishedSources.size,
        operationResults: instance.operationResults.size,
      };
    });

    expect(replay.ack?.data.replayed).toBe(true);
    expect(
      replay.ack?.data.canonicalState?.sourceStates?.[participantKey],
    ).toEqual(
      expect.objectContaining({
        audio: expect.objectContaining({
          generation: 1,
          desiredState: "active",
        }),
      }),
    );
    expect(replay.roomRevision).toBe(first.roomRevision);
    expect(replay.sourceRevision).toBe(first.sourceRevision);
    expect(replay.publicationRevision).toBe(first.publicationRevision);
    expect(replay.publishedSources).toBe(first.publishedSources);
    expect(replay.operationResults).toBeGreaterThan(0);
  });

  it("accepts a valid newer connection epoch without duplicating canonical state", async () => {
    const id = env.MEDIA_ROOM_DO.idFromName(
      `round3-epoch-${crypto.randomUUID()}`,
    );
    const stub = env.MEDIA_ROOM_DO.get(id);
    const initialMessage = {
      type: "media-sources",
      data: {
        sources: ["audio"],
        operationId: "epoch-initial",
        connectionEpoch: 1,
        sourceStates: {
          audio: { generation: 1, desiredState: "active" },
        },
      },
    };

    const initial = await runInDurableObject(stub, async (instance) => {
      instance.stateLoaded = true;
      instance.participants.set(participantKey, createParticipant(1));
      instance.participantConnectionEpochs.set(participantKey, 1);
      instance.isCurrentParticipantSession = () => true;
      const ws = createWs();
      await instance.handleMessage(ws, createSession(1), initialMessage);
      return {
        roomRevision: instance.roomRevision.toString(),
        sourceRevision: instance.sourceRevision,
        publicationRevision: instance.publicationRevision,
      };
    });

    await evictDurableObject(stub, { webSockets: "close" });

    const replay = await runInDurableObject(stub, async (instance) => {
      instance.participants.set(participantKey, createParticipant(2, true));
      instance.participantConnectionEpochs.set(participantKey, 2);
      instance.isCurrentParticipantSession = () => true;
      const ws = createWs();
      await instance.handleMessage(ws, createSession(2), {
        type: "media-sources",
        data: {
          sources: ["audio"],
          operationId: "epoch-replay",
          connectionEpoch: 2,
          sourceStates: {
            audio: { generation: 1, desiredState: "active" },
          },
        },
      });
      return {
        ack: ws.messages.at(-1),
        roomRevision: instance.roomRevision.toString(),
        sourceRevision: instance.sourceRevision,
        publicationRevision: instance.publicationRevision,
        connectionEpoch:
          instance.participants.get(participantKey)?.connectionEpoch,
      };
    });

    expect(replay.ack?.data.accepted).toBe(true);
    expect(replay.roomRevision).toBe(initial.roomRevision);
    expect(replay.sourceRevision).toBe(initial.sourceRevision);
    expect(replay.publicationRevision).toBe(initial.publicationRevision);
    expect(replay.connectionEpoch).toBe(2);
  });
});
